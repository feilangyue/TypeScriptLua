import * as ts from 'typescript';
import { BinaryWriter } from './binarywriter';
import { FunctionContext } from './contexts';
import { IdentifierResolver, ResolvedInfo, ResolvedKind } from './resolvers';
import { Ops, OpMode, OpCodes, LuaTypes } from './opcodes';
import { Helpers } from './helpers';

export class Emitter {
    public writer: BinaryWriter = new BinaryWriter();
    private functionContextStack: Array<FunctionContext> = [];
    private functionContext: FunctionContext;
    private resolver: IdentifierResolver;

    public constructor(typeChecker: ts.TypeChecker) {
        this.resolver = new IdentifierResolver(typeChecker);
    }

    public processNode(node: ts.Node): void {
        switch (node.kind) {
            case ts.SyntaxKind.SourceFile: this.processFile(<ts.SourceFile>node); return;
            case ts.SyntaxKind.Bundle: this.processBundle(<ts.Bundle>node); return;
            case ts.SyntaxKind.UnparsedSource: this.processUnparsedSource(<ts.UnparsedSource>node); return;
        }

        // TODO: finish it
        throw new Error('Method not implemented.');
    }

    private pushFunctionContext(location: ts.Node) {
        const localFunctionContext = this.functionContext;
        this.functionContextStack.push(localFunctionContext);
        this.functionContext = new FunctionContext();
        this.functionContext.container = localFunctionContext;
        this.functionContext.location_node = location;
    }

    private popFunctionContext(): FunctionContext {
        const localFunctionContext = this.functionContext;
        this.functionContext = this.functionContextStack.pop();
        return localFunctionContext;
    }

    private processFunction(location: ts.Node, statements: ts.NodeArray<ts.Statement>): FunctionContext {
        this.pushFunctionContext(location);
        statements.forEach(s => {
            this.processStatement(s);
        });

        // add final 'RETURN'
        this.functionContext.code.push([Ops.RETURN, 0, 1]);

        return this.popFunctionContext();
    }

    private processFile(sourceFile: ts.SourceFile): void {
        this.emitHeader();

        const localFunctionContext = this.processFunction(sourceFile, sourceFile.statements);

        // this is global function
        localFunctionContext.is_vararg = true;

        // f->sizeupvalues (byte)
        this.writer.writeByte(localFunctionContext.upvalues.length);
        this.emitFunction(localFunctionContext);
    }

    private processBundle(bundle: ts.Bundle): void {
        throw new Error('Method not implemented.');
    }

    private processUnparsedSource(unparsedSource: ts.UnparsedSource): void {
        throw new Error('Method not implemented.');
    }

    private processStatement(node: ts.Statement): void {
        switch (node.kind) {
            case ts.SyntaxKind.EmptyStatement: return;
            case ts.SyntaxKind.VariableStatement: this.processVariableStatement(<ts.VariableStatement>node); return;
            case ts.SyntaxKind.FunctionDeclaration: this.processFunctionDeclaration(<ts.FunctionDeclaration>node); return;
            case ts.SyntaxKind.ReturnStatement: this.processReturnStatement(<ts.ReturnStatement>node); return;
            case ts.SyntaxKind.ExpressionStatement: this.processExpressionStatement(<ts.ExpressionStatement>node); return;
        }

        // TODO: finish it
        throw new Error('Method not implemented.');
    }

    private processExpression(node: ts.Expression): void {
        switch (node.kind) {
            case ts.SyntaxKind.CallExpression: this.processCallExpression(<ts.CallExpression>node); return;
            case ts.SyntaxKind.PropertyAccessExpression: this.processPropertyAccessExpression(<ts.PropertyAccessExpression>node); return;
            case ts.SyntaxKind.BinaryExpression: this.processBinaryExpression(<ts.BinaryExpression>node); return;
            case ts.SyntaxKind.FunctionExpression: this.processFunctionExpression(<ts.FunctionExpression>node); return;
            case ts.SyntaxKind.ArrowFunction: this.processArrowFunction(<ts.ArrowFunction>node); return;
            case ts.SyntaxKind.ElementAccessExpression: this.processElementAccessExpression(<ts.ElementAccessExpression>node); return;
            case ts.SyntaxKind.TrueKeyword:
            case ts.SyntaxKind.FalseKeyword: this.processBooleanLiteral(<ts.BooleanLiteral>node); return;
            case ts.SyntaxKind.NullKeyword: this.processNullLiteral(<ts.NullLiteral>node); return;
            case ts.SyntaxKind.NumericLiteral: this.processNumericLiteral(<ts.NumericLiteral>node); return;
            case ts.SyntaxKind.StringLiteral: this.processStringLiteral(<ts.StringLiteral>node); return;
            case ts.SyntaxKind.ArrayLiteralExpression: this.processArrayLiteralExpression(<ts.ArrayLiteralExpression>node); return;
            case ts.SyntaxKind.Identifier: this.processIndentifier(<ts.Identifier>node); return;
        }

        // TODO: finish it
        throw new Error('Method not implemented.');
    }

    private processExpressionStatement(node: ts.ExpressionStatement): void {
        this.processExpression(node.expression);
    }

    private processVariableStatement(node: ts.VariableStatement): void {
        node.declarationList.declarations.forEach(d => {
            if (Helpers.isConstOrLet(node.declarationList)) {

                const localVarRegisterInfo = this.functionContext.createLocal((<ts.Identifier>d.name).text);

                // reduce available register to store result
                // DO NOT DELETE IT
                this.functionContext.popRegister(localVarRegisterInfo);

                if (d.initializer) {
                    this.processExpression(d.initializer);
                } else {
                    this.processNullLiteral(null);
                }
            } else {
                const nameConstIndex = -this.functionContext.findOrCreateConst((<ts.Identifier>d.name).text);
                if (d.initializer) {
                    this.processExpression(d.initializer);
                    this.emitStoreToEnvObjectProperty(nameConstIndex);
                }
            }
        });
    }

    private emitStoreToEnvObjectProperty(nameConstIndex: number) {
        const resolvedInfo = this.functionContext.stack.pop();

        this.functionContext.code.push([
            Ops.SETTABUP,
            this.resolver.returnResolvedEnv(this.functionContext).getRegisterOrIndex(),
            nameConstIndex,
            resolvedInfo.getRegisterOrIndex()]);
    }

    private processFunctionExpression(node: ts.FunctionExpression): void {
        const protoIndex = -this.functionContext.createProto(this.processFunction(node, node.body.statements));

        const resolvedInfo = new ResolvedInfo(this.functionContext);
        resolvedInfo.kind = ResolvedKind.Closure;
        resolvedInfo.protoIndex = protoIndex;
        resolvedInfo.node = node;
        this.functionContext.stack.push(resolvedInfo);
    }

    private processArrowFunction(node: ts.ArrowFunction): void {

        if (node.body.kind !== ts.SyntaxKind.Block) {
            throw new Error('Arrow function as expression is not implemented yet');
        }

        const protoIndex = -this.functionContext.createProto(this.processFunction(node, (<ts.FunctionBody>node.body).statements));

        const resolvedInfo = new ResolvedInfo(this.functionContext);
        resolvedInfo.kind = ResolvedKind.Closure;
        resolvedInfo.protoIndex = protoIndex;
        resolvedInfo.node = node;
        this.functionContext.stack.push(resolvedInfo);
    }

    private processFunctionDeclaration(node: ts.FunctionDeclaration): void {
        const nameConstIndex = -this.functionContext.findOrCreateConst(node.name.text);
        this.processFunctionExpression(<ts.FunctionExpression><any>node);

        const resolvedInfo = this.functionContext.stack.pop();
        const resultInfo = this.functionContext.useRegisterAndPush();
        this.functionContext.code.push([Ops.CLOSURE, resultInfo.getRegister(), resolvedInfo.getProto()]);

        this.emitStoreToEnvObjectProperty(nameConstIndex);
    }

    private processReturnStatement(node: ts.ReturnStatement): void {
        if (node.expression) {
            this.processExpression(node.expression);

            const resultInfo = this.consumeExpression(this.functionContext.stack.pop());

            this.functionContext.code.push(
                [Ops.RETURN, resultInfo.getRegister(), 2]);
        } else {
            this.functionContext.code.push([Ops.RETURN, 0, 1]);
        }
    }

    private processBooleanLiteral(node: ts.BooleanLiteral): void {
        const boolValue = node.kind === ts.SyntaxKind.TrueKeyword;
        const opCode = [Ops.LOADBOOL, this.functionContext.useRegisterAndPush().getRegister(), boolValue ? 1 : 0, 0];
        this.functionContext.code.push(opCode);
    }

    private processNullLiteral(node: ts.NullLiteral): void {
        const resultInfo = this.functionContext.useRegisterAndPush();
        // LOADNIL A B     R(A), R(A+1), ..., R(A+B) := nil
        this.functionContext.code.push([Ops.LOADNIL, resultInfo.getRegister(), resultInfo.getRegister()]);
    }

    private processConst(value: any, node: ts.Node): ResolvedInfo {
        const resolvedInfo = new ResolvedInfo(this.functionContext);
        resolvedInfo.kind = ResolvedKind.Const;
        resolvedInfo.value = value;
        resolvedInfo.node = node;
        resolvedInfo.ensureConstIndex();
        return resolvedInfo;
    }

    private processNumericLiteral(node: ts.NumericLiteral): void {
        const resultInfo = this.functionContext.useRegisterAndPush();
        const resolvedInfo = this.processConst(node.text.indexOf('.') === -1 ? parseInt(node.text, 10) : parseFloat(node.text), node);
        // LOADK A Bx    R(A) := Kst(Bx)
        this.functionContext.code.push([Ops.LOADK, resultInfo.getRegister(), resolvedInfo.getRegisterOrIndex()]);
    }

    private processStringLiteral(node: ts.StringLiteral): void {
        const resultInfo = this.functionContext.useRegisterAndPush();
        const resolvedInfo = this.processConst(node.text, node);
        // LOADK A Bx    R(A) := Kst(Bx)
        this.functionContext.code.push([Ops.LOADK, resultInfo.getRegister(), resolvedInfo.getRegisterOrIndex()]);
    }

    private processArrayLiteralExpression(node: ts.ArrayLiteralExpression): void {
        const resultInfo = this.functionContext.useRegisterAndPush();
        this.functionContext.code.push([
            Ops.NEWTABLE,
            resultInfo.getRegister(),
            node.elements.length,
            0]);

        if (node.elements.length > 0) {
            const reversedValues = (<Array<any>><any>node.elements.slice(1)).reverse();

            reversedValues.forEach((e, index: number) => {
                this.processExpression(e);
            });

            const resolvedElements: Array<any> = [];
            reversedValues.forEach(a => {
                // pop method arguments
                resolvedElements.push(this.functionContext.stack.pop());
            });

            let lastInfo;
            resolvedElements.forEach(e => {
                // pop method arguments
                const currentInfo = this.consumeExpression(e);
                if (lastInfo === undefined) {
                    lastInfo = currentInfo;
                }
            });

            if (node.elements.length > 511) {
                throw new Error('finish using C in SETLIST');
            }

            this.functionContext.code.push(
                [Ops.SETLIST, resultInfo.getRegister(), reversedValues.length, 1]);

            // set 0 element
            this.processExpression(<ts.NumericLiteral>{ kind: ts.SyntaxKind.NumericLiteral, text: '0' });
            this.processExpression(node.elements[0]);

            const zeroValueInfo = this.consumeExpression(this.functionContext.stack.pop(), true);
            const zeroIndexInfo = this.consumeExpression(this.functionContext.stack.pop(), true);

            this.functionContext.code.push(
                [Ops.SETTABLE,
                resultInfo.getRegister(),
                zeroIndexInfo.getRegisterOrIndex(),
                zeroValueInfo.getRegisterOrIndex()]);
        }
    }

    private processElementAccessExpression(node: ts.ElementAccessExpression): void {
        this.processExpression(node.expression);
        this.processExpression(node.argumentExpression);

        // perform load
        const resolvedInfo = new ResolvedInfo(this.functionContext);
        resolvedInfo.kind = ResolvedKind.LoadElement;
        resolvedInfo.currentInfo = this.functionContext.stack.pop();
        resolvedInfo.parentInfo = this.functionContext.stack.pop();

        this.functionContext.stack.push(resolvedInfo);
    }

    private processBinaryExpression(node: ts.BinaryExpression): void {
        // ... = <right>
        this.processExpression(node.right);

        // <left> = ...
        this.processExpression(node.left);

        // perform '='
        switch (node.operatorToken.kind) {
            case ts.SyntaxKind.EqualsToken:

                const leftNode = this.functionContext.stack.pop();
                const rightNode = this.functionContext.stack.pop();
                if (leftNode.kind === ResolvedKind.LoadMember) {
                    this.functionContext.code.push([
                        Ops.SETTABUP,
                        leftNode.parentInfo.getUpvalue(),
                        leftNode.currentInfo.getRegisterOrIndex(),
                        rightNode.getRegisterOrIndex()]);
                } else if (leftNode.kind === ResolvedKind.Register) {
                    this.functionContext.code.push([Ops.MOVE, leftNode.getRegister(), rightNode.getRegister()]);
                } else {
                    throw new Error('Not Implemented');
                }

                break;

                case ts.SyntaxKind.PlusToken:
                case ts.SyntaxKind.MinusToken:
                case ts.SyntaxKind.AsteriskToken:
                case ts.SyntaxKind.AsteriskAsteriskToken:
                case ts.SyntaxKind.PercentToken:
                case ts.SyntaxKind.CaretToken:
                case ts.SyntaxKind.SlashToken:
                case ts.SyntaxKind.AmpersandToken:
                case ts.SyntaxKind.LessThanLessThanToken:
                case ts.SyntaxKind.GreaterThanGreaterThanToken:
                case ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken:

                const leftOpNode = this.consumeExpression(this.functionContext.stack.pop(), true);
                const rightOpNode = this.consumeExpression(this.functionContext.stack.pop(), true);
                const resultInfo = this.functionContext.useRegisterAndPush();

                const opsMap = [];
                opsMap[ts.SyntaxKind.PlusToken] = Ops.ADD;
                opsMap[ts.SyntaxKind.MinusToken] = Ops.SUB;
                opsMap[ts.SyntaxKind.AsteriskToken] = Ops.MUL;
                opsMap[ts.SyntaxKind.PercentToken] = Ops.MOD;
                opsMap[ts.SyntaxKind.AsteriskAsteriskToken] = Ops.POW;
                opsMap[ts.SyntaxKind.SlashToken] = Ops.DIV;
                //// opsMap[ts.SyntaxKind.] = Ops.IDIV;
                opsMap[ts.SyntaxKind.AmpersandToken] = Ops.BAND;
                opsMap[ts.SyntaxKind.ColonToken] = Ops.BOR;
                opsMap[ts.SyntaxKind.CaretToken] = Ops.BXOR;
                opsMap[ts.SyntaxKind.LessThanLessThanToken] = Ops.SHL;
                opsMap[ts.SyntaxKind.GreaterThanGreaterThanToken] = Ops.SHR;
                opsMap[ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken] = Ops.SHR;

                this.functionContext.code.push([
                    opsMap[node.operatorToken.kind],
                    resultInfo.getRegister(),
                    leftOpNode.getRegisterOrIndex(),
                    rightOpNode.getRegisterOrIndex()]);

                break;

            default: throw new Error('Not Implemented');
        }
    }

    private processCallExpression(node: ts.CallExpression): void {

        this.processExpression(node.expression);

        node.arguments.slice().reverse().forEach(a => {
            // pop method arguments
            this.processExpression(a);
        });

        node.arguments.forEach(a => {
            this.functionContext.stack.pop();
        });
        const methodResolvedInfo = this.functionContext.stack.pop();

        // TODO: temporary solution: if method called in Statement then it is not returning value
        const isStatementCall = node.parent.kind === ts.SyntaxKind.ExpressionStatement;
        const isMethodArgumentCall = node.parent.kind === ts.SyntaxKind.CallExpression;
        const returnCount = isStatementCall ? 1 : isMethodArgumentCall ? 0 : 2;

        if (returnCount !== 1) {
            this.functionContext.useRegisterAndPush();
        }

        this.functionContext.code.push(
            [Ops.CALL, methodResolvedInfo.getRegister(), node.arguments.length + 1, returnCount]);
    }

    // method to load constants into registers when they are needed, for example for CALL code.
    private consumeExpression(
        resolvedInfo: ResolvedInfo, allowConst?: boolean, cloneRegister?: boolean, resultInfoTopStack?: ResolvedInfo): ResolvedInfo {
        // if it simple expression of identifier

        if (resolvedInfo.kind === ResolvedKind.LoadElement) {
            const variableInfo = this.consumeExpression(resolvedInfo.parentInfo);
            const indexInfo = this.consumeExpression(resolvedInfo.currentInfo, true);

            if (variableInfo.kind === ResolvedKind.Upvalue) {
                throw new Error('Not implemented');
            } else if (variableInfo.kind === ResolvedKind.Register) {

                const resultInfo = this.functionContext.useRegister();
                this.functionContext.code.push(
                    [Ops.GETTABLE,
                    resultInfo.getRegister(),
                    variableInfo.getRegisterOrIndex(),
                    indexInfo.getRegisterOrIndex()]);

                this.functionContext.stack.push(resultInfo);

                return resultInfo;
            }
        }

        if (resolvedInfo.kind === ResolvedKind.Upvalue) {
            return resolvedInfo;
        }

        throw new Error('Not Implemented');
    }

    private processIndentifier(node: ts.Identifier): void {
        const resolvedInfo = this.resolver.resolver(<ts.Identifier>node, this.functionContext);
        if (resolvedInfo.kind === ResolvedKind.Register) {
            const resultInfo = this.functionContext.useRegisterAndPush();
            this.functionContext.code.push([Ops.MOVE, resultInfo.getRegister(), resolvedInfo.getRegisterOrIndex()]);
            return;
        }

        if (resolvedInfo.kind === ResolvedKind.LoadMember) {
            const resultInfo = this.functionContext.useRegisterAndPush();
            const objectIdentifierInfo = resolvedInfo.parentInfo;
            const memberIdentifierInfo = resolvedInfo.currentInfo;
            this.functionContext.code.push(
                [Ops.GETTABUP,
                resultInfo.getRegister(),
                objectIdentifierInfo.getRegisterOrIndex(),
                memberIdentifierInfo.getRegisterOrIndex()]);
            return;
        }

        if (resolvedInfo.kind === ResolvedKind.Upvalue
            || resolvedInfo.kind === ResolvedKind.Const) {
            this.functionContext.stack.push(resolvedInfo);
            return;
        }

        throw new Error('Not Implemeneted');
    }

    private processPropertyAccessExpression(node: ts.PropertyAccessExpression): void {
        this.processExpression(node.expression);

        this.resolver.Scope.push(this.functionContext.stack.peek());
        this.processExpression(node.name);
        this.resolver.Scope.pop();

        // perform load
        const memberIdentifierInfo = this.functionContext.stack.pop();
        const objectIdentifierInfo = this.functionContext.stack.pop();

        const resultInfo = this.functionContext.useRegisterAndPush();
        this.functionContext.code.push(
            [Ops.GETTABUP,
            resultInfo.getRegister(),
            objectIdentifierInfo.getRegisterOrIndex(),
            memberIdentifierInfo.getRegisterOrIndex()]);
    }

    private emitHeader(): void {
        // writing header
        // LUA_SIGNATURE
        this.writer.writeArray([0x1b, 0x4c, 0x75, 0x61]);
        // LUAC_VERSION, LUAC_FORMAT
        this.writer.writeArray([0x53, 0x00]);
        // LUAC_DATA: data to catch conversion errors
        this.writer.writeArray([0x19, 0x93, 0x0d, 0x0a, 0x1a, 0x0a]);
        // sizeof(int), sizeof(size_t), sizeof(Instruction), sizeof(lua_Integer), sizeof(lua_Number)
        this.writer.writeArray([0x04, 0x08, 0x04, 0x08, 0x08]);
        // LUAC_INT
        this.writer.writeArray([0x78, 0x56, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0]);
        // LUAC_NUM
        this.writer.writeArray([0x0, 0x0, 0x0, 0x0, 0x0, 0x28, 0x77, 0x40]);
    }

    private emitFunction(functionContext: FunctionContext): void {
        this.emitFunctionHeader(functionContext);
        this.emitFunctionCode(functionContext);
        this.emitConstants(functionContext);
        this.emitUpvalues(functionContext);
        this.emitProtos(functionContext);
        this.emitDebug(functionContext);
    }

    private emitFunctionHeader(functionContext: FunctionContext): void {
        // write debug info, by default 0 (string)
        this.writer.writeString(functionContext.debug_location || null);

        // f->linedefined = 0, (int)
        this.writer.writeInt(functionContext.linedefined || 0);

        // f->lastlinedefined = 0, (int)
        this.writer.writeInt(functionContext.lastlinedefined || 0);

        // f->numparams (byte)
        this.writer.writeByte(functionContext.numparams || 0);

        // f->is_vararg (byte)
        this.writer.writeByte(functionContext.is_vararg ? 1 : 0);

        // f->maxstacksize
        this.writer.writeByte(functionContext.maxstacksize);
    }

    private emitFunctionCode(functionContext: FunctionContext): void {
        this.writer.writeInt(functionContext.code.length);

        functionContext.code.forEach(c => {
            // create 4 bytes value
            const opCodeMode: OpMode = OpCodes[c[0]];
            const encoded = opCodeMode.encode(c);
            this.writer.writeInt(encoded);
        });
    }

    private emitConstants(functionContext: FunctionContext): void {
        this.writer.writeInt(functionContext.contants.length);

        functionContext.contants.forEach(c => {

            if (c !== null) {
                // create 4 bytes value
                switch (typeof c) {
                    case 'boolean':
                        this.writer.writeByte(LuaTypes.LUA_TBOOLEAN);
                        this.writer.writeByte(c);
                        break;
                    case 'number':
                        if (Number.isInteger(c)) {
                            this.writer.writeByte(LuaTypes.LUA_TNUMINT);
                            this.writer.writeInteger(c);
                        } else {
                            this.writer.writeByte(LuaTypes.LUA_TNUMBER);
                            this.writer.writeNumber(c);
                        }
                        break;
                    case 'string':
                        if ((<string>c).length > 255) {
                            this.writer.writeByte(LuaTypes.LUA_TLNGSTR);
                        } else {
                            this.writer.writeByte(LuaTypes.LUA_TSTRING);
                        }

                        this.writer.writeString(c);
                        break;
                    default: throw new Error('Method not implemeneted');
                }
            } else {
                this.writer.writeByte(LuaTypes.LUA_TNIL);
            }
        });
    }

    private emitUpvalues(functionContext: FunctionContext): void {
        this.writer.writeInt(functionContext.upvalues.length);

        functionContext.upvalues.forEach((upvalue, index: number) => {
            // in stack (bool)
            this.writer.writeByte((functionContext.container) ? 0 : 1);
            // index
            this.writer.writeByte(index);
        });
    }

    private emitProtos(functionContext: FunctionContext): void {
        this.writer.writeInt(functionContext.protos.length);

        functionContext.protos.forEach(p => {
            // TODO: finish it
            this.emitFunction(p);
        });
    }

    private emitDebug(functionContext: FunctionContext): void {

        if (functionContext.debug.length === 0) {
            this.writer.writeInt(0);
            this.writer.writeInt(0);
            this.writer.writeInt(0);
        } else {
            throw new Error('Method not implemeneted');
        }
    }
}
