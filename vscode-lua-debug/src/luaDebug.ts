import {
    Logger, logger,
    LoggingDebugSession,
    InitializedEvent, TerminatedEvent, StoppedEvent, BreakpointEvent, OutputEvent,
    Thread, StackFrame, Scope, Source, Handles, Breakpoint
} from 'vscode-debugadapter';
import { DebugProtocol } from 'vscode-debugprotocol';
import { basename } from 'path';
import { LuaRuntime, LuaBreakpoint, VariableTypes } from './luaRuntime';
import { Subject } from 'await-notify';


/**
 * This interface describes the mock-debug specific launch attributes
 * (which are not part of the Debug Adapter Protocol).
 * The schema for these attributes lives in the package.json of the mock-debug extension.
 * The interface should always match this schema.
 */
interface LaunchRequestArguments extends DebugProtocol.LaunchRequestArguments {
    /** An absolute path to the "program" to debug. */
    program: string;
    /** Automatically stop target after launch. If not specified, target does not stop. */
    stopOnEntry?: boolean;
    /** enable logging the Debug Adapter Protocol */
    trace?: boolean;
    /** An absolute path to the lua "executable" to launch. */
    luaExecutable: string;
}

export class LuaDebugSession extends LoggingDebugSession {

    // we don't support multiple threads, so we can use a hardcoded ID for the default thread
    private static THREAD_ID = 1;

    // a Mock runtime (or debugger)
    private _runtime: LuaRuntime;

    private _variableHandles = new Handles<string>();

    private _configurationDone = new Subject();

	/**
	 * Creates a new debug adapter that is used for one debug session.
	 * We configure the default implementation of a debug adapter here.
	 */
    public constructor() {
        super("lua-debug.txt");

        // this debugger uses zero-based lines and columns
        this.setDebuggerLinesStartAt1(true);
        this.setDebuggerColumnsStartAt1(false);

        this._runtime = new LuaRuntime();

        // setup event handlers
        this._runtime.on('stopOnEntry', () => {
            this.sendEvent(new StoppedEvent('entry', LuaDebugSession.THREAD_ID));
        });
        this._runtime.on('stopOnStep', () => {
            this.sendEvent(new StoppedEvent('step', LuaDebugSession.THREAD_ID));
        });
        this._runtime.on('stopOnBreakpoint', () => {
            this.sendEvent(new StoppedEvent('breakpoint', LuaDebugSession.THREAD_ID));
        });
        this._runtime.on('stopOnException', () => {
            this.sendEvent(new StoppedEvent('exception', LuaDebugSession.THREAD_ID));
        });
        this._runtime.on('breakpointValidated', (bp: LuaBreakpoint) => {
            this.sendEvent(new BreakpointEvent('changed', <DebugProtocol.Breakpoint>{ verified: bp.verified, id: bp.id }));
        });
        this._runtime.on('output', (text, filePath, line, column) => {
            const e: DebugProtocol.OutputEvent = new OutputEvent(`${text}\n`);
            e.body.source = this.createSource(filePath);
            e.body.line = this.convertDebuggerLineToClient(line);
            e.body.column = this.convertDebuggerColumnToClient(column);
            this.sendEvent(e);
        });
        this._runtime.on('end', () => {
            this.sendEvent(new TerminatedEvent());
        });
    }

	/**
	 * The 'initialize' request is the first request called by the frontend
	 * to interrogate the features the debug adapter provides.
	 */
    protected initializeRequest(response: DebugProtocol.InitializeResponse, args: DebugProtocol.InitializeRequestArguments): void {

        // build and return the capabilities of this debug adapter:
        response.body = response.body || {};

        // the adapter implements the configurationDoneRequest.
        response.body.supportsConfigurationDoneRequest = true;

        // make VS Code to use 'evaluate' when hovering over source
        response.body.supportsEvaluateForHovers = true;

        // make VS Code to show a 'step back' button
        response.body.supportsStepBack = true;

        this.sendResponse(response);

        // since this debug adapter can accept configuration requests like 'setBreakpoint' at any time,
        // we request them early by sending an 'initializeRequest' to the frontend.
        // The frontend will end the configuration sequence by calling 'configurationDone' request.
        this.sendEvent(new InitializedEvent());
    }

	/**
	 * Called at the end of the configuration sequence.
	 * Indicates that all breakpoints etc. have been sent to the DA and that the 'launch' can start.
	 */
    protected configurationDoneRequest(response: DebugProtocol.ConfigurationDoneResponse, args: DebugProtocol.ConfigurationDoneArguments): void {
        super.configurationDoneRequest(response, args);

        // notify the launchRequest that configuration has finished
        this._configurationDone.notify();
    }

    protected async launchRequest(response: DebugProtocol.LaunchResponse, args: LaunchRequestArguments) {

        // make sure to 'Stop' the buffered logging if 'trace' is not set
        logger.setup(args.trace ? Logger.LogLevel.Verbose : Logger.LogLevel.Stop, false);

        // wait until configuration has finished (and configurationDoneRequest has been called)
        await this._configurationDone.wait(1000);

        // start the program in the runtime
        await this._runtime.start(args.program, !!args.stopOnEntry, args.luaExecutable);

        this.sendResponse(response);
    }

    protected async setBreakPointsRequest(response: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments) {

        const path = <string>args.source.path;
        const clientLines = args.lines || [];

        // clear all breakpoints for this file
        this._runtime.clearBreakpoints(path);

        // set and verify breakpoint locations
        const actualBreakpoints = new Array<DebugProtocol.Breakpoint>();
        for (const element of clientLines) {
            let { verified, line, id } = await this._runtime.setBreakPoint(path, this.convertClientLineToDebugger(element));
            const bp = <DebugProtocol.Breakpoint>new Breakpoint(verified, this.convertDebuggerLineToClient(line));
            bp.id = id;
            actualBreakpoints.push(bp);
        }

        // send back the actual breakpoint positions
        response.body = {
            breakpoints: actualBreakpoints
        };
        this.sendResponse(response);
    }

    protected threadsRequest(response: DebugProtocol.ThreadsResponse): void {

        // runtime supports now threads so just return a default thread.
        response.body = {
            threads: [
                new Thread(LuaDebugSession.THREAD_ID, "thread 1")
            ]
        };
        this.sendResponse(response);
    }

    protected async stackTraceRequest(response: DebugProtocol.StackTraceResponse, args: DebugProtocol.StackTraceArguments) {

        const startFrame = typeof args.startFrame === 'number' ? args.startFrame : 0;
        const maxLevels = typeof args.levels === 'number' ? args.levels : 1000;
        const endFrame = startFrame + maxLevels;

        const stk = await this._runtime.stack(startFrame, endFrame);

        response.body = {
            stackFrames: stk.frames.map(f => new StackFrame(f.index, f.name, this.createSource(f.file), this.convertDebuggerLineToClient(f.line))),
            totalFrames: stk.count
        };
        this.sendResponse(response);
    }

    protected scopesRequest(response: DebugProtocol.ScopesResponse, args: DebugProtocol.ScopesArguments): void {

        const frameReference = args.frameId;
        const scopes = new Array<Scope>();

        scopes.push(new Scope("Locals", this._variableHandles.create("local_" + frameReference), false));
        scopes.push(new Scope("Ups", this._variableHandles.create("up_" + frameReference), false));
        scopes.push(new Scope("Globals", this._variableHandles.create("global_" + frameReference), true));

        response.body = {
            scopes: scopes
        };
        this.sendResponse(response);
    }

    protected async variablesRequest(response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments) {

        const id = this._variableHandles.get(args.variablesReference);

        let variableType = VariableTypes.All;
        if (id.startsWith("local_")) {
            variableType = VariableTypes.Local;
        } else if (id.startsWith("up_")) {
            variableType = VariableTypes.Up;
        } else if (id.startsWith("global_")) {
            variableType = VariableTypes.Global;
        }

        const variables = await this._runtime.dumpVariables(variableType);

        /*
        const variables = new Array<DebugProtocol.Variable>();
        if (id !== null) {
            variables.push({
                name: id + "_i",
                type: "integer",
                value: "123",
                variablesReference: 0
            });
            variables.push({
                name: id + "_f",
                type: "float",
                value: "3.14",
                variablesReference: 0
            });
            variables.push({
                name: id + "_s",
                type: "string",
                value: "hello world",
                variablesReference: 0
            });
            variables.push({
                name: id + "_o",
                type: "object",
                value: "Object",
                variablesReference: this._variableHandles.create("object_")
            });
        }
        */

        response.body = {
            variables: variables
        };
        this.sendResponse(response);
    }

    protected async continueRequest(response: DebugProtocol.ContinueResponse, args: DebugProtocol.ContinueArguments) {
        await this._runtime.continue();
        this.sendResponse(response);
    }

    protected async reverseContinueRequest(response: DebugProtocol.ReverseContinueResponse, args: DebugProtocol.ReverseContinueArguments) {
        await this._runtime.continue(true);
        this.sendResponse(response);
    }

    protected async nextRequest(response: DebugProtocol.NextResponse, args: DebugProtocol.NextArguments) {
        await this._runtime.step();
        this.sendResponse(response);
    }

    protected stepBackRequest(response: DebugProtocol.StepBackResponse, args: DebugProtocol.StepBackArguments): void {
        this._runtime.step(true);
        this.sendResponse(response);
    }

    protected async evaluateRequest(response: DebugProtocol.EvaluateResponse, args: DebugProtocol.EvaluateArguments) {

        let reply: string | undefined = undefined;

        if (args.context === 'repl') {
            // 'evaluate' supports to create and delete breakpoints from the 'repl':
            const matches = /new +([0-9]+)/.exec(args.expression);
            if (matches && matches.length === 2) {
                const mbp = await this._runtime.setBreakPoint(this._runtime.sourceFile, this.convertClientLineToDebugger(parseInt(matches[1])));
                const bp = <DebugProtocol.Breakpoint>new Breakpoint(mbp.verified, this.convertDebuggerLineToClient(mbp.line), undefined, this.createSource(this._runtime.sourceFile));
                bp.id = mbp.id;
                this.sendEvent(new BreakpointEvent('new', bp));
                reply = `breakpoint created`;
            } else {
                const matches = /del +([0-9]+)/.exec(args.expression);
                if (matches && matches.length === 2) {
                    const mbp = await this._runtime.clearBreakPoint(this._runtime.sourceFile, this.convertClientLineToDebugger(parseInt(matches[1])));
                    if (mbp) {
                        const bp = <DebugProtocol.Breakpoint>new Breakpoint(false);
                        bp.id = mbp.id;
                        this.sendEvent(new BreakpointEvent('removed', bp));
                        reply = `breakpoint deleted`;
                    }
                }
            }
        }

        response.body = {
            result: reply ? reply : `evaluate(context: '${args.context}', '${args.expression}')`,
            variablesReference: 0
        };
        this.sendResponse(response);
    }

    //---- helpers

    private createSource(filePath: string): Source {
        return new Source(basename(filePath), this.convertDebuggerPathToClient(filePath), undefined, undefined, 'lua-file-adapter-data');
    }
}
