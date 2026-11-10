import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import sys

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
from build import build,read_config
from scripts.package import workflow_plist
from scripts.check_public import inspect

spec=importlib.util.spec_from_file_location('native_installer',ROOT/'native-bridge/install.py')
installer=importlib.util.module_from_spec(spec);spec.loader.exec_module(installer)


class DistributionTests(unittest.TestCase):
    def test_public_defaults_have_no_personal_entries(self):
        self.assertEqual(read_config(),{'version':1,'profile':'Default','entries':[]})

    def test_invalid_paths_and_scope_parameters_are_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            path=Path(temp)/'config.json'
            for profile in ['../Default','.','/tmp/Profile','name\nInjected']:
                path.write_text(json.dumps({'version':1,'profile':profile,'entries':[]}))
                with self.assertRaises(ValueError):read_config(path)
            entry={'id':'project','url':'https://app.example.test/team/issues?account=other',
                   'scope':{'origin':'https://app.example.test','pathPrefix':'/team/','queryKeys':[]}}
            path.write_text(json.dumps({'version':1,'profile':'Default','entries':[entry]}))
            with self.assertRaises(ValueError):read_config(path)

    def test_custom_build_does_not_change_public_defaults(self):
        original=(ROOT/'entry-reuse-config.json').read_bytes()
        with tempfile.TemporaryDirectory() as temp:
            build(Path(temp),{'version':1,'profile':'Profile 1','entries':[]})
            self.assertEqual(json.loads((Path(temp)/'alias-config.json').read_text())['profile'],'Profile 1')
        self.assertEqual((ROOT/'entry-reuse-config.json').read_bytes(),original)

    def test_installer_supports_selected_id_and_profile_and_preserves_user_aliases(self):
        with tempfile.TemporaryDirectory() as temp:
            home=Path(temp);value=installer.install(home,'a'*32,'Profile 1',dry_run=True)
            self.assertFalse((home/'Library').exists())
            value=installer.install(home,'a'*32,'Profile 1')
            manifest=json.loads(Path(value['manifest']).read_text())
            self.assertEqual(manifest['allowed_origins'],['chrome-extension://'+'a'*32+'/'])
            runtime=Path(value['runtime'])
            self.assertEqual(json.loads((runtime/'alias-config.json').read_text())['profile'],'Profile 1')
            loaded_spec=importlib.util.spec_from_file_location('configured_test_host',runtime/'host.py')
            loaded=importlib.util.module_from_spec(loaded_spec);loaded_spec.loader.exec_module(loaded)
            self.assertEqual(loaded.PROFILE,'Profile 1')
            aliases=runtime/'search-aliases.json';aliases.write_text('{}')
            installer.uninstall(home);self.assertTrue(aliases.exists())
            self.assertFalse(Path(value['manifest']).exists())

    def test_installer_refuses_to_overwrite_another_native_host(self):
        with tempfile.TemporaryDirectory() as temp:
            _,path,_=installer.installation(Path(temp),'a'*32,'Default')
            path.parent.mkdir(parents=True);path.write_text('{"path":"/different/program"}')
            with self.assertRaises(RuntimeError):installer.install(Path(temp),'a'*32,'Default')
            with self.assertRaises(RuntimeError):installer.uninstall(Path(temp))

    def test_packaged_hotkey_is_chrome_only_and_copy_preserves_the_argument(self):
        data=workflow_plist()
        hotkey=next(o for o in data['objects'] if o['type'].endswith('.hotkey'))
        self.assertEqual(hotkey['config']['relatedApps'],['com.google.Chrome'])
        self.assertEqual(hotkey['config']['relatedAppsMode'],1)
        copy=next(o for o in data['objects'] if 'pbcopy' in o['config'].get('script',''))
        self.assertIn('printf \'%s\' "$1"',copy['config']['script'])

    def test_release_guard_rejects_private_configs_and_home_paths(self):
        errors=[]
        inspect('entry-reuse-config.json',b'{"profile":"Default","entries":[{"id":"private"}]}',errors)
        inspect('sample.txt',('/'+'Users/'+'someone/'+'data').encode(),errors)
        self.assertEqual(len(errors),2)


if __name__=='__main__':unittest.main()
