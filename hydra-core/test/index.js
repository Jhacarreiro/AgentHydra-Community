// node 22 resolves `node --test test/` as a path, so this loads every suite for that command.
for (const name of ['hook', 'hook-inject', 'install', 'stop']) import(`./${name}.test.mjs`)
