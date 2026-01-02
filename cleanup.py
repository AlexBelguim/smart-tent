import os

files = [
    'verify_dreo_creds.py', 'get_client_secrets.py', 'find_endpoints.py', 
    'inspect_helpers_body.py', 'find_url_const.py', 'test_dreo_patch.py', 
    'inspect_helpers.py', 'inspect_login.py', 'read_dreo_source.py', 
    'deep_inspect_dreo.py', 'inspect_dreo.py', 'test_dreo.py',
    'verify_enum.py', 'reproduce_issue.py', 'inspect_api.py',
    'find_exact_enum.py', 'brute_force.py', 'test_sequence.py',
    'find_enum.py'
]

for f in files:
    try:
        if os.path.exists(f):
            os.remove(f)
            print(f"Removed {f}")
    except Exception as e:
        print(f"Error removing {f}: {e}")
