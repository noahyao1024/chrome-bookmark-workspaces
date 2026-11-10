"""Check tracked source and release archives for accidentally bundled local data."""
from pathlib import Path, PurePosixPath
import argparse
import io
import json
import re
import subprocess
import zipfile

ROOT=Path(__file__).resolve().parent.parent
PATTERNS=[
    ('absolute home path',rb'/Users/[A-Za-z0-9_.-]+/'),
    ('GitHub access token',rb'(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})'),
    ('private key',rb'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----'),
]
FORBIDDEN=re.compile(r'(?:-installation\.json$|(?:bookmarks|history)-(?:before|after)|\.local\.json$|\.jsonl$|\.log$|\.DS_Store$)')


def inspect(name,data,errors,depth=0):
    if FORBIDDEN.search(name) or PurePosixPath(name).name in ('Bookmarks','History','Cookies'):
        errors.append(name+': local data filename')
    for label,pattern in PATTERNS:
        if re.search(pattern,data):errors.append(name+': '+label)
    if name.endswith(('config.example.json','entry-reuse-config.json','alias-config.json')):
        value=json.loads(data)
        if value.get('profile')!='Default' or value.get('entries',[])!=[]:
            errors.append(name+': personalized release config')
    if name.endswith('entry-reuse-config.mjs'):
        value=json.loads(data.decode().split('export default ',1)[1].strip().rstrip(';'))
        if value.get('profile')!='Default' or value.get('entries')!=[]:
            errors.append(name+': personalized extension config')
    if name.endswith(('.zip','.alfredworkflow')):
        if depth>=3:raise ValueError('Nested archive depth exceeds limit')
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            if sum(i.file_size for i in archive.infolist())>100_000_000:raise ValueError('Unexpected archive size')
            for item in archive.infolist():
                if item.is_dir():continue
                if item.filename.startswith('/') or '..' in PurePosixPath(item.filename).parts:
                    errors.append(name+': unsafe archive path');continue
                inspect(name+'!'+item.filename,archive.read(item),errors,depth+1)


def check(artifacts=False):
    errors=[]
    result=subprocess.run(['git','ls-files','-z'],cwd=ROOT,capture_output=True)
    if result.returncode==0 and result.stdout:
        files=[ROOT/p.decode() for p in result.stdout.split(b'\0') if p]
    else:
        files=[p for p in ROOT.rglob('*') if p.is_file() and not any(part in ('.git','.build','dist','__pycache__') for part in p.relative_to(ROOT).parts)
               and p.name not in ('chrome-launcher','timing-send') and not p.name.endswith('.local.json')]
    for path in files:inspect(str(path.relative_to(ROOT)),path.read_bytes(),errors)
    if artifacts:
        archives=list((ROOT/'dist').glob('*.zip'))+list((ROOT/'dist').glob('*.alfredworkflow'))
        if not archives:errors.append('No release archives found')
        for path in archives:inspect(str(path.relative_to(ROOT)),path.read_bytes(),errors)
    if errors:raise RuntimeError('\n'.join(errors))
    print('Public-content checks passed for '+str(len(files))+' source files'+(' and release archives.' if artifacts else '.'))


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--artifacts',action='store_true')
    check(parser.parse_args().artifacts)
