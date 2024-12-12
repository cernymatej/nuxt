import { walk as _walk } from 'estree-walker'
import type { Node, SyncHandler } from 'estree-walker'
import type { Program as ESTreeProgram } from 'estree'
import { parse } from 'acorn'
import type { Program } from 'acorn'

export type { Node }

type WithLocations<T> = T & { start: number, end: number }
type WalkerCallback = (this: ThisParameterType<SyncHandler>, node: WithLocations<Node>, parent: WithLocations<Node> | null, ctx: { key: string | number | symbol | null | undefined, index: number | null | undefined, ast: Program | Node }) => void

export function walk (ast: Program | Node, callback: { enter?: WalkerCallback, leave?: WalkerCallback }) {
  return _walk(ast as unknown as ESTreeProgram | Node, {
    enter (node, parent, key, index) {
      callback.enter?.call(this, node as WithLocations<Node>, parent as WithLocations<Node> | null, { key, index, ast })
    },
    leave (node, parent, key, index) {
      callback.leave?.call(this, node as WithLocations<Node>, parent as WithLocations<Node> | null, { key, index, ast })
    },
  }) as Program | Node | null
}

export function parseAndWalk (code: string, sourceFilename: string, callback: WalkerCallback): Program
export function parseAndWalk (code: string, sourceFilename: string, object: { enter?: WalkerCallback, leave?: WalkerCallback }): Program
export function parseAndWalk (code: string, _sourceFilename: string, callback: { enter?: WalkerCallback, leave?: WalkerCallback } | WalkerCallback) {
  const ast = parse (code, { sourceType: 'module', ecmaVersion: 'latest', locations: true })
  walk(ast, typeof callback === 'function' ? { enter: callback } : callback)
  return ast
}

export function withLocations<T> (node: T): WithLocations<T> {
  return node as WithLocations<T>
}

interface ScopeTrackerNode {
  type: string
  node: Node
}

interface ScopeTrackerFunctionParamNode extends ScopeTrackerNode {
  type: 'FunctionParam'
  fnNode: Node
}

interface ScopeTrackerFunctionNode extends ScopeTrackerNode {
  type: 'Function'
}

interface ScopeTrackerVariableNode extends ScopeTrackerNode {
  type: 'VariableIdentifier'
  variableNode: Node
}

interface ScopeTrackerIdentifierNode extends ScopeTrackerNode {
  type: 'Identifier'
}

interface ScopeTrackerImportNode extends ScopeTrackerNode {
  type: 'Import'
  importNode: Node
}

type ScopeTrackerNodes =
  | ScopeTrackerFunctionParamNode
  | ScopeTrackerFunctionNode
  | ScopeTrackerVariableNode
  | ScopeTrackerIdentifierNode
  | ScopeTrackerImportNode

export function createScopeTracker () {
  const scopes: Map<string, ScopeTrackerNodes>[] = []

  function pushScope () {
    scopes.push(new Map<string, ScopeTrackerNodes>())
  }

  function popScope () {
    scopes.pop()
  }

  function declareIdentifier (name: string, data: ScopeTrackerNodes) {
    scopes[scopes.length - 1]?.set(name, data)
  }

  function isDeclared (name: string) {
    for (let i = scopes.length - 1; i >= 0; i--) {
      if (scopes[i]?.has(name)) {
        return true
      }
    }
    return false
  }

  function getDeclaration (name: string) {
    for (let i = scopes.length - 1; i >= 0; i--) {
      const node = scopes[i]?.get(name)
      if (node) {
        return node
      }
    }
    return null
  }

  function declareFunctionParameter (param: Node, fn: Node) {
    switch (param.type) {
      case 'Identifier':
        declareIdentifier(param.name, {
          type: 'FunctionParam',
          node: param,
          fnNode: fn,
        })
        break
      case 'AssignmentPattern':
        declareFunctionParameter(param.left, fn)
        break
      case 'RestElement':
        declareFunctionParameter(param.argument, fn)
        break
      case 'ArrayPattern':
      case 'ObjectPattern':
        declarePattern(param, {
          type: 'function',
          node: fn,
        })
    }
  }

  function declarePattern (pattern: Node, parent: { type: 'variable' | 'function', node: Node }) {
    switch (pattern.type) {
      case 'Identifier':
        declareIdentifier(pattern.name, parent.type === 'variable'
          ? {
              type: 'VariableIdentifier',
              node: pattern,
              variableNode: parent.node,
            }
          : {
              type: 'FunctionParam',
              node: pattern,
              fnNode: parent.node,
            })
        break
      case 'ArrayPattern':
        for (const element of pattern.elements) {
          if (element) { declarePattern(element, parent) }
        }
        break
      case 'ObjectPattern':
        for (const prop of pattern.properties) {
          if (prop.type === 'Property') {
            declarePattern(prop.value, parent)
          } else if (prop.type === 'RestElement') {
            declarePattern(prop.argument, parent)
          }
        }
        break
      case 'RestElement':
        declarePattern(pattern.argument, parent)
        break
      case 'AssignmentPattern':
        declarePattern(pattern.left, parent)
        break
    }
  }

  function processNodeEnter (node: Node) {
    switch (node.type) {
      case 'Program':
      case 'BlockStatement':
      case 'CatchClause':
      case 'StaticBlock':
        pushScope()
        break

      case 'FunctionDeclaration':
        // declare function name for named functions, skip for `export default`
        if (node.id?.name) {
          declareIdentifier(node.id.name, {
            type: 'Function',
            node,
          })
        }
        pushScope()
        for (const param of node.params) {
          declareFunctionParameter(param, node)
        }
        break

      case 'FunctionExpression':
      case 'ArrowFunctionExpression':
        pushScope()
        for (const param of node.params) {
          declareFunctionParameter(param, node)
        }
        break

      case 'VariableDeclaration':
        for (const decl of node.declarations) {
          declarePattern(decl.id, {
            type: 'variable',
            node,
          })
        }
        break

      case 'ClassDeclaration':
        // declare class name for named classes, skip for `export default`
        if (node.id?.name) {
          declareIdentifier(node.id.name, {
            type: 'Identifier',
            node,
          })
        }
        break

      case 'ClassExpression':
        // make the name of the class available only within the class
        // e.g. const MyClass = class InternalClassName {
        pushScope()
        if (node.id?.name) {
          declareIdentifier(node.id.name, {
            type: 'Identifier',
            node,
          })
        }
        break

      case 'ImportDeclaration':
        for (const specifier of node.specifiers) {
          declareIdentifier(specifier.local.name, {
            type: 'Import',
            node: specifier,
            importNode: node,
          })
        }
        break

      case 'ForStatement':
      case 'ForOfStatement':
      case 'ForInStatement':
        // make the variables defined in for loops available only within the loop
        // e.g. for (let i = 0; i < 10; i++) {
        pushScope()

        if (node.type === 'ForStatement' && node.init?.type === 'VariableDeclaration') {
          for (const decl of node.init.declarations) {
            declarePattern(decl.id, {
              type: 'variable',
              node,
            })
          }
        } else if ((node.type === 'ForOfStatement' || node.type === 'ForInStatement') && node.left.type === 'VariableDeclaration') {
          for (const decl of node.left.declarations) {
            declarePattern(decl.id, {
              type: 'variable',
              node,
            })
          }
        }
        break
    }
  }

  function processNodeLeave (node: Node) {
    switch (node.type) {
      case 'Program':
      case 'BlockStatement':
      case 'CatchClause':
      case 'FunctionDeclaration':
      case 'FunctionExpression':
      case 'ArrowFunctionExpression':
      case 'StaticBlock':
      case 'ClassExpression':
      case 'ForStatement':
      case 'ForOfStatement':
      case 'ForInStatement':
        popScope()
        break
    }
  }

  return {
    isDeclared,
    getDeclaration,
    processNodeEnter,
    processNodeLeave,
  }
}
