import ts from "typescript";

// Node's GET-with-body adapter keeps its reviewed endpoint in a module constant and rejects
// any other pathname or method before calling http(s).request. Match that actual transport
// only when its pathname guard, method guard and request method agree in the same function.
export function restrictedNodeTransportMethod(variable, document) {
  const methods = new Set();
  function visit(node) {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken &&
      ts.isPropertyAccessExpression(node.left) &&
      node.left.name.text === "pathname" &&
      ts.isIdentifier(node.right) &&
      node.right.text === variable
    ) {
      let scope = node.parent;
      while (scope && !ts.isArrowFunction(scope) && !ts.isFunctionExpression(scope) && !ts.isFunctionDeclaration(scope))
        scope = scope.parent;
      if (scope) {
        const guards = new Set();
        const requests = new Set();
        function inspect(child) {
          if (
            ts.isBinaryExpression(child) &&
            child.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken &&
            ts.isPropertyAccessExpression(child.left) &&
            child.left.name.text === "method" &&
            ts.isStringLiteralLike(child.right)
          )
            guards.add(child.right.text);
          if (ts.isCallExpression(child)) {
            const isNodeRequest = (expression) => {
              if (ts.isParenthesizedExpression(expression)) return isNodeRequest(expression.expression);
              if (ts.isConditionalExpression(expression))
                return isNodeRequest(expression.whenTrue) && isNodeRequest(expression.whenFalse);
              return ts.isIdentifier(expression) && ["httpRequest", "httpsRequest"].includes(expression.text);
            };
            if (isNodeRequest(child.expression)) {
              for (const argument of child.arguments) {
                if (!ts.isObjectLiteralExpression(argument)) continue;
                const method = argument.properties.find(
                  (property) => ts.isPropertyAssignment(property) && property.name.getText() === "method",
                );
                if (method && ts.isStringLiteralLike(method.initializer)) requests.add(method.initializer.text);
              }
            }
          }
          ts.forEachChild(child, inspect);
        }
        inspect(scope);
        if (guards.size === 1 && requests.size === 1 && [...guards][0] === [...requests][0])
          methods.add([...requests][0]);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(document);
  return methods.size === 1 ? [...methods][0] : undefined;
}
