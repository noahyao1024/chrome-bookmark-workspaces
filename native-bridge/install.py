"""Install the local native host; never edits bookmarks or the Alfred preferences."""
from pathlib import Path
import argparse
import json
import os
import platform
import re
import shlex
import shutil
import sys

NAME = 'io.github.noahyao1024.bookmark_workspaces'
ROOT = Path(__file__).resolve().parent


def installation(home, extension_id, profile):
    if not re.fullmatch(r'[a-p]{32}', extension_id):
        raise ValueError('Copy the 32-letter extension ID from chrome://extensions')
    if not re.fullmatch(r'[A-Za-z0-9 _.-]+', profile) or profile in ('.', '..'):
        raise ValueError('Invalid profile directory name')
    runtime = Path(home)/'Library/Application Support/BookmarkWorkspaces'
    manifest = Path(home)/'Library/Application Support/Google/Chrome/NativeMessagingHosts'/(NAME+'.json')
    value = {'name': NAME, 'description': 'Bookmark Workspaces native bridge',
             'path': str(runtime/'native-host'), 'type': 'stdio',
             'allowed_origins': ['chrome-extension://'+extension_id+'/']}
    return runtime, manifest, value


def install(home, extension_id, profile, dry_run=False):
    runtime, manifest, value = installation(home, extension_id, profile)
    if manifest.exists() and json.loads(manifest.read_text()).get('path') != value['path']:
        raise RuntimeError('The native-host name belongs to another installation')
    result = {'runtime': str(runtime), 'manifest': str(manifest), 'profile': profile,
              'extensionId': extension_id, 'dryRun': dry_run}
    if dry_run:
        return result
    runtime.mkdir(mode=0o700, parents=True, exist_ok=True)
    manifest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(ROOT/'host.py', runtime/'host.py')
    (runtime/'host.py').chmod(0o600)
    launcher = runtime/'native-host'
    launcher.write_text('#!/bin/sh\nexec '+shlex.quote(sys.executable)+' '+shlex.quote(str(runtime/'host.py'))+' "$@"\n')
    launcher.chmod(0o700)
    config = runtime/'alias-config.json'
    config.write_text(json.dumps({'profile': profile})+'\n');config.chmod(0o600)
    manifest.write_text(json.dumps(value, indent=2)+'\n');manifest.chmod(0o600)
    return result


def uninstall(home):
    runtime, manifest, value = installation(home, 'a'*32, 'Default')
    if manifest.exists():
        if json.loads(manifest.read_text()).get('path') != value['path']:
            raise RuntimeError('Refusing to remove another installation')
        manifest.unlink()
    for name in ['host.py','native-host','alias-config.json']:
        (runtime/name).unlink(missing_ok=True)
    return {'uninstalled': True, 'preserved': 'bookmarks, configuration aliases, cache and logs'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--extension-id')
    parser.add_argument('--profile', default='Default')
    parser.add_argument('--dry-run', action='store_true')
    parser.add_argument('--uninstall', action='store_true')
    args = parser.parse_args()
    if platform.system() != 'Darwin':
        parser.error('The native host installer currently supports macOS only')
    if args.uninstall:
        if args.dry_run:parser.error('--dry-run is for installation only')
        print(json.dumps(uninstall(Path.home())));return
    if not args.extension_id:parser.error('--extension-id is required')
    try:
        print(json.dumps(install(Path.home(), args.extension_id, args.profile, args.dry_run), indent=2))
    except (OSError, ValueError, RuntimeError) as error:
        parser.exit(1, str(error)+'\n')


if __name__ == '__main__':
    main()
