const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const { join, extname } = require('path');
const { parse } = require('@babel/parser');
const traverse = require('@babel/traverse').default;
const { readConfig: _readConfig } = require('@remix-run/dev/dist/config.js');

/**
 * A custom set that allows us to check if an item is already in the set with deep-checking 
 * Normally; { a: 1 } !== { a: 1 } in JS
 * But in this set, they are equal
 * @class CustomSet
 * @extends {Set}
 * 
 * @example
 * ```js
 * const set = new CustomSet();
 * 
 * set.add({ a: 1 });
 * ```
 */
class CustomSet extends Set {
  add(item) {
    for (const existingItem of this) {
      if (isEquivalent(existingItem, item)) {
        return this;
      }
    }
    super.add(item);
    return this;
  }
}

// object property checker...
function isEquivalent(a, b) {
  if (a === b) {
    return true;
  }
  if (typeof a !== 'object' || typeof b !== 'object') {
    return false;
  }
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) {
    return false;
  }
  for (const key of keysA) {
    if (a[key] !== b[key]) {
      return false;
    }
  }
  return true;
}

const app = express();

// Don't ask me why this is here, came with the template I Ctrl C + V'd
app.use(function (req, res) {
  res.send({ msg: "hello" });
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// placeholder for the remix config
let config;

// Extract the config from the Remix app
// by default, when initialising the server, Remix Forge **must** find a way 
// to pass the root directory of the app to the server. Don't forget to change this for testing purposes!
_readConfig('../sw-example', "development").then((_config) => {
  config = _config;
});

const rootDir = '../sw-example'; // Replace with the actual root directory - CHANGE THIS!

const componentMap = {};

// parser. destroy at your discretion 
function parseFile(filePath) {
  const fileContents = fs.readFileSync(filePath, 'utf-8');

  const ast = parse(fileContents, {
    sourceType: 'module',
    plugins: ['jsx', 'typescript'],
  });

  let componentName = null;
  let imports = [];
  let externalComponents = new CustomSet();

  traverse(ast, {
    ImportDeclaration(path) {
      const importSource = path.node.source.value;
      const importSpecifier = path.node.specifiers.map(specifier => {
        if (filePath == '../sw-example/app/routes/foo.tsx') {
          console.log(specifier, 'specifier')
        }

        return specifier.local.name;
      });

      if (path.node.importKind === 'type') {
        return;
      }

      if (importSource.startsWith('.') || importSource.startsWith('~')) {
        imports.push({ source: importSource, specifier: importSpecifier, isExternal: false });
      } else {
        imports.push({ source: importSource, specifier: importSpecifier, isExternal: true });
      }
    },
    ExportDefaultDeclaration(path) {
      if (filePath == '../sw-example/app/routes/foo.tsx') {
        console.log('Get lost! I\'m in...', 'mid-lower')
      }
      const declarationType = path.node.declaration.type;
      if (declarationType === 'Identifier') {
        componentName = path.node.declaration.name;
      } else if (declarationType === 'FunctionDeclaration') {
        componentName = path.node.declaration.id.name;
      }
    },
    JSXIdentifier(path) {
      const identifierName = path.node.name;
      if (identifierName[0] === identifierName[0].toUpperCase()) {
        const resolvedIdentifier = imports.find((ident) => {
          return ident.specifier.find(specifier => specifier === identifierName);
        });

        if (resolvedIdentifier === undefined) {
          return;
        }

        externalComponents.add({
          children: resolvedIdentifier.isExternal ? null : [],
          componentName: identifierName,
          componentPath: resolvedIdentifier.source
        })
      }
    },
  });

  /**
   * @type {string}
   */
  let sourceMapEntryId = filePath.replace(rootDir, '').replace('.tsx', '').replace('.jsx', '');

  if (sourceMapEntryId[0] === '/') {
    sourceMapEntryId = sourceMapEntryId.slice(1);
  }

  if (sourceMapEntryId.includes('routes/')) {
    let index = sourceMapEntryId.indexOf('routes/');
    sourceMapEntryId = sourceMapEntryId.slice(index);
  } else {
    sourceMapEntryId = sourceMapEntryId.replace('app/', '');
  }

  // the second part would break if you create another root route. Anyway, Idc, that's not supposed to happen.
  const isRoute = sourceMapEntryId.startsWith('routes/') || sourceMapEntryId === 'root'

  // Remove entry files out of this! 
  if (componentName && !sourceMapEntryId.startsWith('entry')) {
    componentMap[sourceMapEntryId] = {
      id: sourceMapEntryId,
      componentName,
      isRoute,
      filePath,
      parentId: isRoute ? '' : null,
      fileImports: imports,
      externalComponents: Array.from(externalComponents)
    };
  }
}

// perform a recursive traversal of the app directory
function traverseDirectory(directoryPath) {
  const entries = fs.readdirSync(directoryPath);

  for (const entry of entries) {
    const entryPath = join(directoryPath, entry);
    const stats = fs.statSync(entryPath);

    if (stats.isDirectory()) {
      traverseDirectory(entryPath);
    } else if (stats.isFile() && (extname(entryPath) === '.jsx' || extname(entryPath) === '.tsx')) {
      parseFile(entryPath);
    }
  }
}

// by default, we should be passing `config.appDirectory` to the `traverseDirectory` function but eh, I'm lazy
traverseDirectory(rootDir + '/app');

wss.on('connection', function connection(ws, req) {
  ws.on('message', function incoming(message) {
    let msg = JSON.parse(message);
    console.log('received: %s', msg);

    // no idea what this prints, ik I used it at first 
    const fileMetaData = Object.values(config.routes).find(route => route.id === msg.routeId);

    console.log('fileMetaData: ', fileMetaData)

    // send the built map back (source map)
    ws.send(JSON.stringify({ __appManifest: componentMap }))

    // console.log('config: ', config)
  });

  ws.send('something');
});

server.listen(8080, function listening() {
  console.log('Listening on %d', server.address().port);
});