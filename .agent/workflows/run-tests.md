---
description: how to run tests and node commands in this project
---

# Running Commands (Node / Jest / Yarn)

Node.js is managed via nvm and is located at:
`/home/jhav/.local/share/nvm/v24.14.0/bin/`

## Checking Supabase local status

From the user fish terminal (has Docker access):
```bash
npx supabase status
npx supabase start   # if not running
```

From agent terminal (direct binary):
```bash
/home/jhav/ai-scheduling-orchestrator/node_modules/supabase/bin/supabase status
```

## Running unit tests

// turbo
```bash
/home/jhav/.local/share/nvm/v24.14.0/bin/node \
  /home/jhav/ai-scheduling-orchestrator/node_modules/.bin/jest \
  --selectProjects unit --forceExit
```

## Running all tests

// turbo
```bash
/home/jhav/.local/share/nvm/v24.14.0/bin/node \
  /home/jhav/ai-scheduling-orchestrator/node_modules/.bin/jest --forceExit
```

## Running yarn commands

Always use the full path:
```bash
/home/jhav/.local/share/nvm/v24.14.0/bin/node \
  /home/jhav/.local/share/nvm/v24.14.0/bin/yarn <command>
```

## Note
The `config.fish` file has been updated to add Node to the PATH in all sessions,
so after restarting the terminal `node`, `yarn`, `npx`, `jest` will all work directly.
