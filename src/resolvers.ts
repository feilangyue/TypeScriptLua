import * as ts from 'typescript';
import { FunctionContext } from './contexts';
import { Helpers } from './helpers';

export enum ResolvedKind {
    Upvalue,
    Const,
    Register
}

export class ResolvedInfo {
    public kind: ResolvedKind;
    public value: number;
    public name: string;
}

export class IdentifierResolver {

    public constructor(private typeChecker: ts.TypeChecker) {
    }

    public resolver(identifier: ts.Identifier, functionContext: FunctionContext): ResolvedInfo {
        if ((<any>identifier).resolved_owner) {
            return this.resolveMemberOfResolvedOwner(identifier, functionContext);
        }

        const resolved = (<any>this.typeChecker).resolveName(identifier.text, undefined, ((1 << 27) - 1)/*mask for all types*/);
        if (resolved) {
            const kind: ts.SyntaxKind = <ts.SyntaxKind>resolved.valueDeclaration.kind;
            switch (kind) {
                case ts.SyntaxKind.VariableDeclaration:
                    const type = resolved.valueDeclaration.type;
                    // can be keyward to 'string'
                    if (type.typeName) {
                        switch (type.typeName.text) {
                            case 'Console':
                                return (<any>identifier).resolved_value = this.returnResolvedEnv(functionContext);
                        }
                    }

                    if (!Helpers.isConstOrLet(identifier)) {
                        (<any>identifier).resolved_owner = this.returnResolvedEnv(functionContext);
                        return this.resolveMemberOfResolvedOwner(identifier, functionContext);
                    } else {
                        // TODO: finish returning info about local variable
                        throw new Error('Not Implemented');
                    }

                    break;

                case ts.SyntaxKind.FunctionDeclaration:
                    (<any>identifier).resolved_owner = this.returnResolvedEnv(functionContext);
                    return this.resolveMemberOfResolvedOwner(identifier, functionContext);
            }
        }

        // TODO: hack
        throw new Error('Coult not resolve: ' + identifier.text);
    }

    public returnResolvedEnv(functionContext: FunctionContext): ResolvedInfo {
        const resolvedInfo = new ResolvedInfo();
        resolvedInfo.kind = ResolvedKind.Upvalue;
        resolvedInfo.name = '_ENV';
        resolvedInfo.value = -functionContext.findOrCreateUpvalue(resolvedInfo.name);
        return resolvedInfo;
    }

    private resolveMemberOfResolvedOwner(identifier: ts.Identifier, functionContext: FunctionContext): ResolvedInfo {
        const resolved_owner: any = (<any>identifier).resolved_owner;
        if (resolved_owner && resolved_owner.kind === ResolvedKind.Upvalue) {
            const resolvedInfo = new ResolvedInfo();
            resolvedInfo.kind = ResolvedKind.Const;
            resolvedInfo.name = identifier.text;

            // resolve _ENV
            // TODO: hack
            if (resolved_owner.name === '_ENV') {
                switch (resolvedInfo.name) {
                    case 'log': resolvedInfo.name = 'print'; break;
                }
            }

            resolvedInfo.value = -functionContext.findOrCreateConst(resolvedInfo.name);
            return resolvedInfo;
        }

        throw new Error('Method not implemented');
    }
}