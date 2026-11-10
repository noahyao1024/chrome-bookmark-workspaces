"""Build a standalone Alfred workflow and the matching Chrome extension bundle."""
from pathlib import Path
import argparse
import json
import plistlib
import shutil
import subprocess
import sys
import uuid
import zipfile

ROOT=Path(__file__).resolve().parent.parent
sys.path.insert(0,str(ROOT))
from build import build, read_config
from scripts.generate_icons import generate


def workflow_plist():
    uid=lambda name:str(uuid.uuid5(uuid.NAMESPACE_URL,'https://github.com/noahyao1024/chrome-bookmark-workspaces/'+name)).upper()
    search,action,copy,hotkey=[uid(name) for name in ['search','action','copy','hotkey']]
    objects=[
      {'uid':search,'type':'alfred.workflow.input.scriptfilter','version':3,'config':{
        'keyword':'t','withspace':True,'title':'Chrome bookmarks and tabs','subtext':'Search bookmark names, tabs and history',
        'runningsubtext':'Reading Chrome…','script':'./chrome-launcher "$1"','scriptargtype':1,'scriptfile':'','type':0,
        'argumenttype':1,'argumenttrimmode':0,'argumenttreatemptyqueryasnil':False,'escaping':68,
        'alfredfiltersresults':False,'alfredfiltersresultsmatchmode':2,'queuemode':1,'queuedelaymode':0,
        'queuedelaycustom':3,'queuedelayimmediatelyinitially':True}},
      {'uid':action,'type':'alfred.workflow.action.script','version':2,'config':{
        'script':'./chrome-activate.sh "$1"','scriptargtype':1,'scriptfile':'','type':0,'escaping':0,'concurrently':False}},
      {'uid':copy,'type':'alfred.workflow.action.script','version':2,'config':{
        'script':'./timing-send copy_begin "${chrome_search_trace:-}" "$1" >/dev/null 2>&1\nprintf \'%s\' "$1" | /usr/bin/pbcopy',
        'scriptargtype':1,'scriptfile':'','type':0,'escaping':0,'concurrently':False}},
      {'uid':hotkey,'type':'alfred.workflow.trigger.hotkey','version':2,'config':{
        'action':0,'argument':0,'focusedappvariable':False,'focusedappvariablename':'','hotkey':17,'hotmod':1048576,
        'hotstring':'T','leftcursor':False,'modsmode':0,'relatedApps':['com.google.Chrome'],'relatedAppsMode':1}}
    ]
    connect=lambda target,mods=0:{'destinationuid':target,'modifiers':mods,'modifiersubtext':'','vitoclose':False}
    return {'bundleid':'io.github.noahyao1024.bookmark-workspaces','name':'Bookmark Workspaces','createdby':'Noah Yao',
      'description':'Chrome bookmark aliases, tab reuse and workspace groups','version':json.loads((ROOT/'package.json').read_text())['version'],
      'webaddress':'https://github.com/noahyao1024/chrome-bookmark-workspaces','disabled':False,
      'objects':objects,'connections':{search:[connect(action),connect(action,1048576),connect(copy,262144)],hotkey:[connect(search)]},
      'uidata':{search:{'xpos':180,'ypos':80},action:{'xpos':490,'ypos':80},copy:{'xpos':490,'ypos':210},hotkey:{'xpos':20,'ypos':80}},
      'readme':'t searches Chrome. Return reuses, Command-Return opens another copy, Control-Return copies the full URL. Command-T applies only while Chrome is frontmost.'}


def archive(folder,target):
    with zipfile.ZipFile(target,'w',zipfile.ZIP_DEFLATED) as zipped:
        for path in sorted(Path(folder).rglob('*')):
            if path.is_file():zipped.write(path,path.relative_to(folder))


def package(config=None,skip_build=False):
    value=read_config(config)
    if json.loads((ROOT/'package.json').read_text())['version'] != json.loads((ROOT/'bookmark-groups-extension/manifest.json').read_text())['version']:
        raise ValueError('Package and extension versions must match')
    if not skip_build:subprocess.run([sys.executable,str(ROOT/'build_launcher.py'),'--universal'],check=True)
    output=ROOT/'dist';output.mkdir(exist_ok=True)
    runtime=output/'workflow';extension=output/'extension';bundle=output/'bookmark-workspaces-macos'
    for folder in [runtime,extension,bundle]:
        if folder.exists():shutil.rmtree(folder)
        folder.mkdir()
    build(runtime,value)
    for name in ['chrome-launcher','timing-send','chrome-activate.sh']:
        shutil.copy2(ROOT/name,runtime/name);(runtime/name).chmod(0o755)
    generate(runtime/'result-icons')
    shutil.copy2(runtime/'result-icons/workflow.png',runtime/'icon.png')
    (runtime/'info.plist').write_bytes(plistlib.dumps(workflow_plist()))
    shutil.copy2(ROOT/'LICENSE',runtime/'LICENSE')
    shutil.copytree(ROOT/'third_party',runtime/'third_party')
    for path in (ROOT/'bookmark-groups-extension').iterdir():
        if path.name=='manifest.json' or (path.suffix=='.mjs' and '.test.' not in path.name):shutil.copy2(path,extension/path.name)
    shutil.copy2(runtime/'bookmark-groups-extension/alias-core.mjs',extension/'alias-core.mjs')
    shutil.copy2(runtime/'result-icons/workflow.png',extension/'icon.png')
    (extension/'entry-reuse-config.mjs').write_text('// Generated; contains only the explicitly selected config.\nexport default '+json.dumps(value,indent=2)+';\n')
    shutil.rmtree(runtime/'bookmark-groups-extension')
    archive(runtime,output/'Bookmark-Workspaces.alfredworkflow')
    archive(extension,output/'bookmark-workspaces-extension.zip')
    shutil.copytree(extension,bundle/'extension')
    (bundle/'native-bridge').mkdir()
    for name in ['host.py','install.py']:shutil.copy2(ROOT/'native-bridge'/name,bundle/'native-bridge'/name)
    for name in ['README.md','README.zh-CN.md','LICENSE','THIRD_PARTY_NOTICES.md','SECURITY.md']:shutil.copy2(ROOT/name,bundle/name)
    (bundle/'timing').mkdir();shutil.copy2(ROOT/'timing/README.md',bundle/'timing/README.md')
    shutil.copytree(ROOT/'third_party',bundle/'third_party')
    shutil.copy2(output/'Bookmark-Workspaces.alfredworkflow',bundle/'Bookmark-Workspaces.alfredworkflow')
    archive(bundle,output/'bookmark-workspaces-macos-universal.zip')
    print(json.dumps({'workflow':str(output/'Bookmark-Workspaces.alfredworkflow'),'bundle':str(output/'bookmark-workspaces-macos-universal.zip'),'profile':value['profile']}))


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config',type=Path)
    parser.add_argument('--skip-build',action='store_true')
    args=parser.parse_args();package(args.config,args.skip_build)
