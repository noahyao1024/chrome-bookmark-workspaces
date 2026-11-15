"""Build, install or remove the optional macOS Control-Tab preview helper."""
from pathlib import Path
import argparse,json,os,platform,plistlib,re,shutil,signal,subprocess,time

ROOT=Path(__file__).resolve().parent.parent
NAME='Bookmark Workspaces Switcher'
EXECUTABLE='BookmarkWorkspacesSwitcher'
IDENTIFIER='io.github.noahyao1024.BookmarkWorkspacesSwitcher'
LABEL='io.github.noahyao1024.bookmark-workspaces.switcher'
APP=Path.home()/'Applications'/(NAME+'.app')
JOB=Path.home()/'Library/LaunchAgents'/(LABEL+'.plist')
CACHE=Path.home()/'Library/Caches/BookmarkWorkspaces'

def build(universal=False):
    if platform.system()!='Darwin':raise RuntimeError('The optional tab switcher requires macOS 14 or newer')
    output=ROOT/'tab-switcher/.build';output.mkdir(exist_ok=True)
    architectures=['arm64','x86_64'] if universal else [platform.machine()]
    parts=[];prefix=str(ROOT)+'=/src/bookmark-workspaces'
    sources=['SwitcherCore.swift','NativeClient.swift','PreviewPanel.swift','ThumbnailCache.swift','TabSwitcherApp.swift']
    for arch in architectures:
        target=arch+'-apple-macosx14.0';obj=output/('client-'+arch+'.o');binary=output/(EXECUTABLE+'-'+arch)
        subprocess.run(['clang','-O2','-target',target,'-ffile-prefix-map='+prefix,'-c',str(ROOT/'timing/client.c'),'-o',str(obj)],check=True)
        subprocess.run(['swiftc','-O','-target',target,'-file-prefix-map',prefix,*[str(ROOT/'tab-switcher'/name) for name in sources],str(obj),'-o',str(binary)],check=True)
        parts.append(str(binary))
    binary=ROOT/'tab-switcher'/EXECUTABLE;temporary=binary.with_name('.'+EXECUTABLE+'.next')
    if universal:subprocess.run(['lipo','-create',*parts,'-output',str(temporary)],check=True)
    else:shutil.copy2(parts[0],temporary)
    temporary.chmod(0o755);subprocess.run(['codesign','--force','--sign','-',str(temporary)],check=True);os.replace(temporary,binary)
    return binary

def stop():
    subprocess.run(['launchctl','bootout','gui/'+str(os.getuid()),str(JOB)],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    try:
        pid=int(json.loads((CACHE/'tab-switcher-health.json').read_text())['pid'])
        command=subprocess.check_output(['ps','-p',str(pid),'-o','comm='],text=True).strip()
        if command==str(APP/'Contents/MacOS'/EXECUTABLE):
            os.kill(pid,signal.SIGTERM)
            for _ in range(30):
                try:os.kill(pid,0)
                except ProcessLookupError:break
                time.sleep(.05)
    except (OSError,KeyError,ValueError,subprocess.CalledProcessError):pass

def install(binary,profile,request_permissions=False):
    if not re.fullmatch(r'[A-Za-z0-9 _.-]+',profile) or profile in ('.','..'):raise ValueError('Invalid Chrome profile directory')
    stop()
    contents=APP/'Contents';macos=contents/'MacOS';resources=contents/'Resources'
    macos.mkdir(parents=True,exist_ok=True);resources.mkdir(exist_ok=True)
    temporary=macos/('.'+EXECUTABLE+'.next');shutil.copy2(binary,temporary);temporary.chmod(0o755);os.replace(temporary,macos/EXECUTABLE)
    info={'CFBundleIdentifier':IDENTIFIER,'CFBundleName':NAME,'CFBundleDisplayName':NAME,
          'CFBundleExecutable':EXECUTABLE,'CFBundlePackageType':'APPL','CFBundleVersion':'1','CFBundleShortVersionString':'1.0',
          'LSUIElement':True,'NSHighResolutionCapable':True,'LSMinimumSystemVersion':'14.0'}
    (contents/'Info.plist').write_bytes(plistlib.dumps(info));(resources/'config.json').write_text(json.dumps({'profile':profile,'cacheFolder':'BookmarkWorkspaces'}))
    subprocess.run(['codesign','--force','--deep','--sign','-','--identifier',IDENTIFIER,'--requirements','=designated => identifier "'+IDENTIFIER+'"',str(APP)],check=True)
    JOB.parent.mkdir(exist_ok=True)
    JOB.write_bytes(plistlib.dumps({'Label':LABEL,'ProgramArguments':[str(macos/EXECUTABLE)]+(['--request-permissions'] if request_permissions else []),
        'RunAtLoad':True,'KeepAlive':{'SuccessfulExit':False},'ThrottleInterval':10,'ProcessType':'Interactive','LimitLoadToSessionType':'Aqua','Umask':63}))
    JOB.chmod(0o600);subprocess.run(['launchctl','bootstrap','gui/'+str(os.getuid()),str(JOB)],check=True)
    print(json.dumps({'application':str(APP),'launchAgent':str(JOB),'profile':profile}))

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--build-only',action='store_true');parser.add_argument('--universal',action='store_true')
    parser.add_argument('--request-permissions',action='store_true');parser.add_argument('--profile',default='Default');parser.add_argument('--uninstall',action='store_true')
    args=parser.parse_args()
    if args.uninstall:
        stop();JOB.unlink(missing_ok=True);shutil.rmtree(APP,ignore_errors=True)
    elif args.build_only:build(args.universal)
    else:
        binary=ROOT/'tab-switcher'/EXECUTABLE
        install(binary if binary.exists() else build(args.universal),args.profile,args.request_permissions)
