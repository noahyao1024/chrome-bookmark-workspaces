"""Build native or universal macOS binaries (minimum deployment target: 14.0)."""
from pathlib import Path
import argparse
import os
import platform
import subprocess

ROOT = Path(__file__).resolve().parent


def build(universal=False):
    if platform.system() != 'Darwin':
        raise RuntimeError('The Alfred launcher requires macOS; the JavaScript tests do not')
    output = ROOT/'.build'
    output.mkdir(exist_ok=True)
    architectures = ['arm64', 'x86_64'] if universal else [platform.machine()]
    launchers, clients = [], []
    for arch in architectures:
        target = arch+'-apple-macosx14.0'
        obj = output/('client-'+arch+'.o')
        launcher = output/('chrome-launcher-'+arch)
        client = output/('timing-send-'+arch)
        prefix=str(ROOT)+'=/src/bookmark-workspaces'
        subprocess.run(['clang','-O2','-target',target,'-ffile-prefix-map='+prefix,'-c','timing/client.c','-o',str(obj)],cwd=ROOT,check=True)
        subprocess.run(['clang','-O2','-target',target,'-ffile-prefix-map='+prefix,'-DCHROME_TIMING_CLI','timing/client.c','-o',str(client)],cwd=ROOT,check=True)
        subprocess.run(['swiftc','-O','-target',target,'-file-prefix-map',prefix,'launcher.swift',str(obj),'-o',str(launcher)],cwd=ROOT,check=True)
        launchers.append(str(launcher));clients.append(str(client))
    for name, parts in [('chrome-launcher',launchers),('timing-send',clients)]:
        temporary = ROOT/('.'+name+'.next')
        if universal:
            subprocess.run(['lipo','-create',*parts,'-output',str(temporary)],check=True)
        else:
            import shutil
            shutil.copy2(parts[0],temporary)
        temporary.chmod(0o755)
        subprocess.run(['codesign','--force','--sign','-',str(temporary)],check=True)
        os.replace(temporary,ROOT/name)


if __name__ == '__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--universal',action='store_true')
    build(parser.parse_args().universal)
