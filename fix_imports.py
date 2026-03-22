import os

base = r'd:\编程\S级项目'

imp_direct = "import { getServerUrl } from '@/utils/env'"
imp_aliased = "import { getServerUrl as _getServerUrl } from '@/utils/env'"

direct_import = [
    'src/components/world/NexusDetailPanel.tsx',
    'src/components/ai/ChatMessage.tsx',
    'src/components/ai/AddMCPModal.tsx',
    'src/services/OpenClawService.ts',
    'src/services/llmService.ts',
]

aliased_import = [
    'src/components/ai/AIChatPanel.tsx',
    'src/services/installService.ts',
    'src/services/onlineSearchService.ts',
    'src/services/clawHubService.ts',
    'src/services/clawHubAuthService.ts',
]

def add_import(filepath, import_line):
    with open(filepath, 'r', encoding='utf-8') as f:
        content = f.read()
    if import_line in content:
        print(f'{filepath}: already has import')
        return
    lines = content.split('\n')
    insert_idx = 0
    for i, line in enumerate(lines):
        if line.startswith('import '):
            insert_idx = i + 1
    lines.insert(insert_idx, import_line)
    with open(filepath, 'w', encoding='utf-8') as f:
        f.write('\n'.join(lines))
    print(f'{filepath}: added import')

for f in direct_import:
    add_import(os.path.join(base, f), imp_direct)

for f in aliased_import:
    add_import(os.path.join(base, f), imp_aliased)

# Fix LocalClawService.ts - remove unused individual imports
lcs = os.path.join(base, 'src/services/LocalClawService.ts')
with open(lcs, 'r', encoding='utf-8') as f:
    content = f.read()
old_import = "import { isDevMode, isElectronMode, isTauriMode, getServerUrl } from '@/utils/env'"
new_import = "import { getServerUrl } from '@/utils/env'"
if old_import in content:
    content = content.replace(old_import, new_import)
    with open(lcs, 'w', encoding='utf-8') as f:
        f.write(content)
    print('LocalClawService.ts: fixed import')
else:
    print('LocalClawService.ts: import already correct or different')

print('Done')
