"""Explicit opt-in installer for the optional local keydown diagnostics app."""
from pathlib import Path
import argparse
import json
import os
import platform
import plistlib
import shutil
import signal
import subprocess

ROOT=Path(__file__).resolve().parent.parent
LABEL='io.github.noahyao1024.bookmark-workspaces.timing'
APP_ID='io.github.noahyao1024.BookmarkDiagnostics'
APP_NAME='Bookmark Workspaces Diagnostics.app'
EXECUTABLE='BookmarkWorkspacesDiagnostics'


def build_application():
    output=ROOT/'dist'/APP_NAME
    binary=output/'Contents/MacOS'/EXECUTABLE
    binary.parent.mkdir(parents=True,exist_ok=True)
    build=ROOT/'.build';build.mkdir(exist_ok=True)
    target=platform.machine()+'-apple-macosx14.0'
    prefix=str(ROOT)+'=/src/bookmark-workspaces'
    obj=build/'diagnostics-client.o'
    subprocess.run(['clang','-O2','-target',target,'-ffile-prefix-map='+prefix,'-c','timing/client.c','-o',str(obj)],cwd=ROOT,check=True)
    subprocess.run(['swiftc','-O','-target',target,'-file-prefix-map',prefix,
                    'timing/TimingCore.swift','timing/PixelProbe.swift','timing/DiagnosticsApp.swift',str(obj),'-o',str(binary)],cwd=ROOT,check=True)
    info={'CFBundleIdentifier':APP_ID,'CFBundleName':'Bookmark Workspaces Diagnostics',
          'CFBundleDisplayName':'Bookmark Workspaces Diagnostics','CFBundleExecutable':EXECUTABLE,
          'CFBundlePackageType':'APPL','CFBundleVersion':'1','CFBundleShortVersionString':'0.1.0',
          'LSUIElement':True,'LSMinimumSystemVersion':'14.0'}
    (output/'Contents/Info.plist').write_bytes(plistlib.dumps(info))
    subprocess.run(['codesign','--force','--deep','--sign','-','--identifier',APP_ID,
                    '--requirements','=designated => identifier "'+APP_ID+'"',str(output)],check=True)
    return output


def stop_owned(app,agent):
    domain='gui/'+str(os.getuid())
    subprocess.run(['launchctl','bootout',domain,str(agent)],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    health=Path.home()/'Library/Caches/BookmarkWorkspaces/timing-health.json'
    try:
        pid=int(json.loads(health.read_text())['pid'])
        command=subprocess.check_output(['ps','-p',str(pid),'-o','comm='],text=True).strip()
        if command==str(app/'Contents/MacOS'/EXECUTABLE):os.kill(pid,signal.SIGTERM)
    except (OSError,ValueError,KeyError,subprocess.CalledProcessError):pass


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    modes=parser.add_mutually_exclusive_group(required=True)
    modes.add_argument('--build-only',action='store_true')
    modes.add_argument('--install',action='store_true')
    modes.add_argument('--uninstall',action='store_true')
    args=parser.parse_args()
    if platform.system()!='Darwin':parser.error('Diagnostics require macOS')
    app=Path.home()/'Applications'/APP_NAME
    agent=Path.home()/'Library/LaunchAgents'/(LABEL+'.plist')
    if args.uninstall:
        stop_owned(app,agent);agent.unlink(missing_ok=True)
        if app.exists():shutil.rmtree(app)
        print('Diagnostics removed. Existing logs were preserved.');return
    built=build_application()
    if args.build_only:print(built);return
    stop_owned(app,agent)
    app.parent.mkdir(parents=True,exist_ok=True)
    if app.exists():shutil.rmtree(app)
    shutil.copytree(built,app)
    logs=Path.home()/'Library/Logs/BookmarkWorkspaces';logs.mkdir(mode=0o700,parents=True,exist_ok=True)
    for name in ['timing-process.log','timing-process-error.log']:
        p=logs/name;p.touch(exist_ok=True);p.chmod(0o600)
    job={'Label':LABEL,'ProgramArguments':[str(app/'Contents/MacOS'/EXECUTABLE)],
         'RunAtLoad':True,'KeepAlive':{'SuccessfulExit':False},'ThrottleInterval':10,
         'ProcessType':'Interactive','LimitLoadToSessionType':'Aqua','Umask':63,
         'StandardOutPath':str(logs/'timing-process.log'),'StandardErrorPath':str(logs/'timing-process-error.log')}
    agent.parent.mkdir(parents=True,exist_ok=True);agent.write_bytes(plistlib.dumps(job));agent.chmod(0o600)
    subprocess.run(['launchctl','bootstrap','gui/'+str(os.getuid()),str(agent)],check=True)
    print('Installed '+str(app)+'. Grant Input Monitoring and Accessibility manually; Screen Recording is needed only for Alfred result-pixel checks.')


if __name__=='__main__':main()
