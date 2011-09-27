/* See license.txt for terms of usage */

define([
    "firebug/lib/object",
    "firebug/firebug",
    "firebug/chrome/reps",
    "firebug/lib/locale",
    "firebug/lib/events",
    "firebug/lib/wrapper",
    "firebug/lib/url",
    "firebug/lib/css",
    "firebug/lib/dom",
    "firebug/firefox/firefox",
    "firebug/firefox/window",
    "firebug/firefox/system",
    "firebug/lib/xpath",
    "firebug/lib/string",
    "firebug/lib/xml",
    "firebug/lib/array",
    "firebug/lib/persist",
    "firebug/console/eventMonitor",
    "firebug/lib/keywords",
    "firebug/console/console",
    "firebug/console/commandLineExposed"
],
function(Obj, Firebug, FirebugReps, Locale, Events, Wrapper, Url, Css, Dom, Firefox, Win, System,
    Xpath, Str, Xml, Arr, Persist, EventMonitor, Keywords) {

// ************************************************************************************************
// Constants

const Cc = Components.classes;
const Ci = Components.interfaces;

const commandPrefix = ">>>";

const reOpenBracket = /[\[\(\{]/;
const reCloseBracket = /[\]\)\}]/;
const reJSChar = /[a-zA-Z0-9$_]/;
const reStringExpr = /^" *"$/;
const reLiteralExpr = /^[ "0-9,]*$/;
const reCmdSource = /^with\(_FirebugCommandLine\){(.*)};$/;

// ************************************************************************************************
// Globals

// ************************************************************************************************

Firebug.CommandLine = Obj.extend(Firebug.Module,
{
    dispatchName: "commandLine",

    // * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * *

    // targetWindow was needed by evaluateInSandbox, let's leave it for a while in case
    // we rethink this yet again

    initializeCommandLineIfNeeded: function (context, win)
    {
        if (!context || !win)
            return;

      // The command-line requires that the console has been initialized first,
      // so make sure that's so.  This call should have no effect if the console
      // is already initialized.
      var consoleIsReady = Firebug.Console.isReadyElsePreparing(context, win);

      // Make sure the command-line is initialized.  This call should have no
      // effect if the command-line is already initialized.
      var commandLineIsReady = Firebug.CommandLine.isReadyElsePreparing(context, win);

      if (FBTrace.DBG_COMMANDLINE)
          FBTrace.sysout("commandLine.initializeCommandLineIfNeeded console ready: " +
            consoleIsReady + " commandLine ready: " + commandLineIsReady);
    },

    // returns user-level wrapped object I guess.
    evaluate: function(expr, context, thisValue, targetWindow, successConsoleFunction,
        exceptionFunction)
    {
        if (!context)
            return;

        try
        {
            var result = null;
            var debuggerState = Firebug.Debugger.beginInternalOperation();

            if (this.isSandbox(context))
            {
                result = this.evaluateInSandbox(expr, context, thisValue, targetWindow,
                    successConsoleFunction, exceptionFunction);
            }
            else if (Firebug.Debugger.hasValidStack(context))
            {
                result = this.evaluateInDebugFrame(expr, context, thisValue, targetWindow,
                    successConsoleFunction, exceptionFunction);
            }
            else
            {
                result = this.evaluateByEventPassing(expr, context, thisValue, targetWindow,
                    successConsoleFunction, exceptionFunction);
            }

            context.invalidatePanels('dom', 'html');
        }
        catch (exc)  // XXX jjb, I don't expect this to be taken, the try here is for the finally
        {
            if (FBTrace.DBG_ERRORS && FBTrace.DBG_COMMANDLINE)
                FBTrace.sysout("commandLine.evaluate with context.stopped:" + context.stopped +
                    " EXCEPTION " + exc, exc);
        }
        finally
        {
            Firebug.Debugger.endInternalOperation(debuggerState);
        }

        return result;
    },

    evaluateByEventPassing: function(expr, context, thisValue, targetWindow,
        successConsoleFunction, exceptionFunction)
    {
        var win = targetWindow ? targetWindow : (context.baseWindow ? context.baseWindow : context.window);

        if (!win)
        {
            if (FBTrace.DBG_ERRORS && FBTrace.DBG_COMMANDLINE)
                FBTrace.sysout("commandLine.evaluateByEventPassing: no targetWindow!\n");
            return;
        }

        // Detach the commandline API (if attached) to reinitialize it. If e.g.jQuery
        // has been loaded in the meantime, the $ functions shouldn't be overwritten.
        Firebug.CommandLine.injector.detachCommandLine(context, win);

        // Inject commandLine APIs again.
        this.initializeCommandLineIfNeeded(context, win);

        // Make sure the command line script is attached.
        if (!Firebug.CommandLine.isAttached(context, win))
        {
            FBTrace.sysout("commandLine: document does not have command line attached " +
                "its too early for command line "+Win.getWindowId(win)+" location:"+
                Win.safeGetWindowLocation(win), document);

            if (Xml.isXMLPrettyPrint(context, win))
            {
                var msg = Locale.$STR("commandline.disabledForXMLDocs");
                var row = Firebug.Console.logFormatted([msg], context, "warn", true);
                var objectBox = row.querySelector(".objectBox");

                // Log a message with a clickable link that can be used to enable
                // the command line - but the page will switch into HTML. The listener
                // passed into the function is called when the user clicks the link.
                FirebugReps.Description.render(msg, objectBox, Obj.bind(function()
                {
                    // Reset the flag that protect script injection into the page.
                    context.isXMLPrettyPrint = false;

                    // Now inject the command line.
                    Firebug.CommandLine.initializeCommandLineIfNeeded(context, win);
                }, this));
            }
            else
            {
                Firebug.Console.logFormatted(["Firebug cannot find firebug-CommandLineAttached " +
                    "document.getUserData , its too early for command line",
                     win], context, "error", true);
            }
            return;
        }

        var event = document.createEvent("Events");
        event.initEvent("firebugCommandLine", true, false);
        win.document.setUserData("firebug-methodName", "evaluate", null);

        expr = expr.toString();
        expr = "with(_FirebugCommandLine){\n" + expr + "\n};";
        win.document.setUserData("firebug-expr", expr, null);

        var consoleHandler = Firebug.Console.injector.getConsoleHandler(context, win);

        if (!consoleHandler)
        {
            FBTrace.sysout("commandLine evaluateByEventPassing no consoleHandler "+
                Win.safeGetWindowLocation(win));
            return;
        }

        if (successConsoleFunction)
        {
            consoleHandler.setEvaluatedCallback( function useConsoleFunction(result)
            {
                if (result === "_firebugIgnore")
                    return;
                successConsoleFunction(result, context);  // result will be pass thru this function
            });
        }

        if (exceptionFunction)
        {
            consoleHandler.setEvaluateErrorCallback(function useExceptionFunction(result)
            {
                exceptionFunction(result, context, "errorMessage");
            });
        }
        else
        {
            consoleHandler.setEvaluateErrorCallback(function useErrorFunction(result)
            {
                if (result)
                {
                    var m = reCmdSource.exec(result.source);
                    if (m && m.length > 0)
                        result.source = m[1];
                }

                Firebug.Console.logFormatted([result], context, "error", true);
            });
        }

        if (FBTrace.DBG_COMMANDLINE)
            FBTrace.sysout("commandLine.evaluateByEventPassing \'"+expr+"\' using consoleHandler:",
                consoleHandler);
        try
        {
            win.document.dispatchEvent(event);

            // Clean up the command line APIs.
            Firebug.CommandLine.injector.detachCommandLine(context, win);
        }
        catch(exc)
        {
            if (FBTrace.DBG_COMMANDLINE || FBTrace.DBG_ERRORS)
                FBTrace.sysout("commandLine.evaluateByEventPassing dispatchEvent FAILS "+exc,
                    {exc:exc, event:event});
        }

        if (FBTrace.DBG_COMMANDLINE)
            FBTrace.sysout("commandLine.evaluateByEventPassing return after firebugCommandLine " +
                "event:", event);
    },

    evaluateInDebugFrame: function(expr, context, thisValue, targetWindow,
        successConsoleFunction, exceptionFunction)
    {
        var result = null;

        // targetWindow may be frame in HTML
        var win = targetWindow ? targetWindow : (context.baseWindow ? context.baseWindow : context.window);

        if (!context.commandLineAPI)
            context.commandLineAPI = new FirebugCommandLineAPI(context);

        var htmlPanel = context.getPanel("html", true);
        var scope = {
            api       : context.commandLineAPI,
            vars      : htmlPanel?htmlPanel.getInspectorVars():null,
            thisValue : thisValue
        };

        try
        {
            result = Firebug.Debugger.evaluate(expr, context, scope);
            successConsoleFunction(result, context);  // result will be pass thru this function
        }
        catch (e)
        {
            exceptionFunction(e, context);
        }
        return result;
    },

    evaluateByPostMessage: function(expr, context, thisValue, targetWindow, successConsoleFunction,
        exceptionFunction)
    {
        // targetWindow may be frame in HTML
        var win = targetWindow ? targetWindow : (context.baseWindow ? context.baseWindow : context.window);
        if (!win)
        {
            if (FBTrace.DBG_ERRORS && FBTrace.DBG_COMMANDLINE)
                FBTrace.sysout("commandLine.evaluateByPostMessage: no targetWindow!\n");
            return;
        }

        // We're going to use some command-line facilities, but it may not have initialized yet.
        this.initializeCommandLineIfNeeded(context, win);

        expr = expr.toString();
        expr = "with(_FirebugCommandLine){\n" + expr + "\n};";

        var consoleHandler = Firebug.Console.injector.getConsoleHandler(context, win);

        if (!consoleHandler)
        {
            FBTrace.sysout("commandLine evaluateByPostMessage no consoleHandler "+
                Win.safeGetWindowLocation(win));
            return;
        }

        if (successConsoleFunction)
        {
            consoleHandler.setEvaluatedCallback( function useConsoleFunction(result)
            {
                if (result === "_firebugIgnore")
                    return;
                successConsoleFunction(result, context);  // result will be pass thru this function
            });
        }

        if (exceptionFunction)
        {
            consoleHandler.evaluateError = function useExceptionFunction(result)
            {
                exceptionFunction(result, context, "errorMessage");
            }
        }
        else
        {
            consoleHandler.evaluateError = function useErrorFunction(result)
            {
                if (result)
                {
                    var m = reCmdSource.exec(result.source);
                    if (m && m.length > 0)
                        result.source = m[1];
                }

                Firebug.Console.logFormatted([result], context, "error", true);
            }
        }

        return win.postMessage(expr, "*");
    },

    evaluateInWebPage: function(expr, context, targetWindow)
    {
        var win = targetWindow || context.window;
        var element = Dom.addScript(win.document, "_firebugInWebPage", expr);
        if (!element)
            return;

        setTimeout(function delayRemoveScriptTag()
        {
            // we don't need the script element, result is in DOM object
            if (element.parentNode)
                element.parentNode.removeChild(element);
        });

        return "true";
    },

    // isSandbox(context) true, => context.global is a Sandbox
    evaluateInSandbox: function(expr, context, thisValue, targetWindow, successConsoleFunction,
        exceptionFunction)
    {
        var result,
            scriptToEval = expr;

        try
        {
            result = Components.utils.evalInSandbox(scriptToEval, context.global);
            if (FBTrace.DBG_COMMANDLINE)
                FBTrace.sysout("commandLine.evaluateInSandbox success for sandbox ", scriptToEval);
            successConsoleFunction(result, context);  // result will be pass thru this function
        }
        catch (e)
        {
            if (FBTrace.DBG_ERRORS && FBTrace.DBG_COMMANDLINE)
                FBTrace.sysout("commandLine.evaluateInSandbox FAILED in "+context.getName()+
                    " because "+e, e);

            exceptionFunction(e, context);

            result = new FirebugReps.ErrorMessageObj("commandLine.evaluateInSandbox FAILED: " + e,
                Url.getDataURLForContent(scriptToEval, "FirebugCommandLineEvaluate"),
                e.lineNumber, 0, "js", context, null);
        }
        return result;
    },

    isSandbox: function (context)
    {
        return (context.global && context.global+"" === "[object Sandbox]");
    },

    // * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * *

    acceptCompletionOrReturnIt: function(context)
    {
        var commandLine = this.getCommandLine(context);
        var completionBox = this.getCompletionBox();
        if (completionBox.value.length === 0 || commandLine.value.length === completionBox.value.length)
            return this.autoCompleter.getVerifiedText(commandLine); // we have nothing to complete

        this.autoCompleter.acceptCompletionInTextBox(commandLine, completionBox);
        return ""; // next time we will return text
    },

    enter: function(context, command)
    {
        var expr = command ? command : this.acceptCompletionOrReturnIt(context);
        if (expr == "")
            return;

        var mozJSEnabled = Firebug.Options.getPref("javascript", "enabled");
        if (mozJSEnabled)
        {
            if (!Firebug.commandEditor || context.panelName != "console")
            {
                this.clear(context);
                Firebug.Console.log(commandPrefix + " " + expr, context, "command", FirebugReps.Text);
            }
            else
            {
                var shortExpr = Str.cropString(Str.stripNewLines(expr), 100);
                Firebug.Console.log(commandPrefix + " " + shortExpr, context, "command",
                    FirebugReps.Text);
            }

            this.commandHistory.appendToHistory(expr);

            var noscript = getNoScript();
            if (noscript)
            {
                var currentURI = Firefox.getCurrentURI();
                var noScriptURI = currentURI ? noscript.getSite(currentURI.spec) : null;
                if (noScriptURI)
                    noScriptURI = (noscript.jsEnabled || noscript.isJSEnabled(noScriptURI)) ?
                        null : noScriptURI;
            }

            if (noscript && noScriptURI)
                noscript.setJSEnabled(noScriptURI, true);

            var goodOrBad = Obj.bind(Firebug.Console.log, Firebug.Console);
            this.evaluate(expr, context, null, null, goodOrBad, goodOrBad);

            if (noscript && noScriptURI)
                noscript.setJSEnabled(noScriptURI, false);

            this.autoCompleter.reset();
        }
        else
        {
            Firebug.Console.log(Locale.$STR("console.JSDisabledInFirefoxPrefs"), context, "info");
        }
    },

    enterMenu: function(context)
    {
        var expr = this.acceptCompletionOrReturnIt(context);
        if (expr == "")
            return;

        this.commandHistory.appendToHistory(expr, true);

        this.evaluate(expr, context, null, null, function(result, context)
        {
            if (typeof(result) != "undefined")
            {
                Firebug.chrome.contextMenuObject = result;

                var popup = Firebug.chrome.$("fbContextMenu");
                var commandLine = this.getCommandLine(context);
                popup.showPopup(commandLine, -1, -1, "popup", "bottomleft", "topleft");
            }
        });
    },

    enterInspect: function(context)
    {
        var expr = this.acceptCompletionOrReturnIt(context);
        if (expr == "")
            return;

        this.clear(context);
        this.commandHistory.appendToHistory(expr);

        this.evaluate(expr, context, null, null, function(result, context)
        {
            if (typeof(result) != undefined)
                Firebug.chrome.select(result);
        });
    },

    reenter: function(context)
    {
        var command = this.commandHistory.getLastCommand();
        this.enter(context, command);
    },

    copyBookmarklet: function(context)
    {
        var commandLine = this.getCommandLine(context);
        var expr = "javascript: " + Str.stripNewLines(this.autoCompleter.getVerifiedText(commandLine));
        System.copyToClipboard(expr);
    },

    focus: function(context)
    {
        if (Firebug.isDetached())
            Firebug.chrome.focus();
        else
            Firebug.toggleBar(true);

        var commandLine = this.getCommandLine(context);

        if (!context.panelName)
        {
            Firebug.chrome.selectPanel("console");
        }
        else if (context.panelName != "console")
        {
            this.Popup.toggle(Firebug.currentContext);
            setTimeout(function() { commandLine.select(); });
        }
        else
        {
            // We are already on the console, if the command line has also
            // the focus, toggle back. But only if the UI has been already
            // opened.
            if (commandLine.getAttribute("focused") != "true")
                setTimeout(function() { commandLine.select(); });
        }
    },

    clear: function(context)
    {
        var commandLine = this.getCommandLine(context);
        var completionBox = this.getCompletionBox();

        completionBox.value = "";

        // Return false if the command line is already empty.
        if (!commandLine.value)
            return false;

        commandLine.value = context.commandLineText = "";
        this.autoCompleter.reset();
        this.autoCompleter.hide(this.getCompletionBox());

        return true;
    },

    cancel: function(context)
    {
        var commandLine = this.getCommandLine(context);
        if (this.autoCompleter.revert(commandLine))
            return;

        return this.clear(context);
    },

    update: function(context)
    {
        var commandLine = this.getCommandLine(context);
        context.commandLineText = this.autoCompleter.getVerifiedText(commandLine);
    },

    complete: function(context, reverse)
    {
        var commandLine = this.getCommandLine(context);
        var completionBox = this.getCompletionBox();
        this.autoCompleter.complete(context, commandLine, completionBox, true, reverse);
        context.commandLineText = this.autoCompleter.getVerifiedText(commandLine);
        this.autoCompleter.reset();
    },

    // xxxsz: setMultiLine should just be called when switching between Command Line and Command Editor
    setMultiLine: function(multiLine, chrome, saveMultiLine)
    {
        if (Firebug.currentContext && Firebug.currentContext.panelName != "console")
            return;

        Dom.collapse(chrome.$("fbCommandBox"), multiLine);
        Dom.collapse(chrome.$("fbPanelSplitter"), !multiLine);
        Dom.collapse(chrome.$("fbSidePanelDeck"), !multiLine);

        if (multiLine)
            chrome.$("fbSidePanelDeck").selectedPanel = chrome.$("fbCommandEditorBox");

        var commandLine = this.getSingleRowCommandLine();
        var commandEditor = this.getCommandEditor();

        if (saveMultiLine)  // we are just closing the view
        {
            commandLine.value = commandEditor.value;
            return;
        }

        if (Firebug.currentContext)
        {
            Firebug.currentContext.commandLineText = Firebug.currentContext.commandLineText || "";

            if (multiLine)
                commandEditor.value = Str.cleanIndentation(Firebug.currentContext.commandLineText);
            else
                commandLine.value = Str.stripNewLines(Firebug.currentContext.commandLineText);
        }
        // else we may be hiding a panel while turning Firebug off
    },

    toggleMultiLine: function(forceCommandEditor)
    {
        var showCommandEditor = forceCommandEditor || !Firebug.commandEditor;
        if (showCommandEditor != Firebug.commandEditor)
            Firebug.Options.set("commandEditor", showCommandEditor);
    },

    checkOverflow: function(context)
    {
        if (!context)
            return;

        var commandLine = this.getCommandLine(context);
        if (commandLine.value.indexOf("\n") >= 0)
        {
            setTimeout(Obj.bindFixed(function()
            {
                Firebug.Options.set("commandEditor", true);
            }, this));
        }
    },

    onCommandLineOverflow: function(event)
    {
        this.checkOverflow(Firebug.currentContext);
    },

    // * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * *

    setCursor: function(commandLine, position)
    {
        // textbox version, https://developer.mozilla.org/en/XUL/Property/inputField
        // commandLine.inputField.setSelectionRange(command.length, command.length);
        commandLine.setSelectionRange(position, position);
    },

    // * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * *
    // extends Module

    initialize: function()
    {
        Firebug.Module.initialize.apply(this, arguments);

        this.setAutoCompleter();
        this.commandHistory = new Firebug.CommandLine.CommandHistory();

        if (Firebug.commandEditor)
            this.setMultiLine(true, Firebug.chrome);
    },

    setAutoCompleter: function()
    {
        var showCompletionPopup = Firebug.Options.get("commandLineShowCompleterPopup");
        this.autoCompleter = new Firebug.AutoCompleter(getExpressionOffset, getRange,
            Obj.bind(autoCompleteEval, this), false, true, true, true, showCompletionPopup,
            null, simplifyExpr, killCompletions, adjustCompletion);
    },

    initializeUI: function()
    {
        this.onCommandLineFocus = Obj.bind(this.onCommandLineFocus, true);
        this.onCommandLineInput = Obj.bind(this.onCommandLineInput, this);
        this.onCommandLineBlur = Obj.bind(this.onCommandLineBlur, this);
        this.onCommandLineKeyUp = Obj.bind(this.onCommandLineKeyUp, this);
        this.onCommandLineKeyDown = Obj.bind(this.onCommandLineKeyDown, this);
        this.onCommandLineKeyPress = Obj.bind(this.onCommandLineKeyPress, this);
        this.onCommandLineOverflow = Obj.bind(this.onCommandLineOverflow, this);
        this.attachListeners();
    },

    attachListeners: function()
    {
        var commandLine = this.getSingleRowCommandLine(),
            commandEditor = this.getCommandEditor();

        commandEditor.addEventListener('focus', this.onCommandLineFocus, true);
        commandLine.addEventListener('focus', this.onCommandLineFocus, true);
        commandLine.addEventListener('input', this.onCommandLineInput, true);
        commandLine.addEventListener('overflow', this.onCommandLineOverflow, true);
        commandLine.addEventListener('keyup', this.onCommandLineKeyUp, true);
        commandLine.addEventListener('keydown', this.onCommandLineKeyDown, true);
        commandLine.addEventListener('keypress', this.onCommandLineKeyPress, true);
        commandLine.addEventListener('blur', this.onCommandLineBlur, true);

        Firebug.Console.addListener(this);  // to get onConsoleInjection
    },

    shutdown: function()
    {
        var commandLine = this.getSingleRowCommandLine(),
            commandEditor = this.getCommandEditor();

        commandEditor.removeEventListener('focus', this.onCommandLineFocus, true);
        commandLine.removeEventListener('focus', this.onCommandLineFocus, true);
        commandLine.removeEventListener('input', this.onCommandLineInput, true);
        commandLine.removeEventListener('overflow', this.onCommandLineOverflow, true);
        commandLine.removeEventListener('keydown', this.onCommandLineKeyDown, true);
        commandLine.removeEventListener('keypress', this.onCommandLineKeyPress, true);
        commandLine.removeEventListener('blur', this.onCommandLineBlur, true);
    },

    destroyContext: function(context, persistedState)
    {
        var panelState = Persist.getPersistedState(this, "console");
        panelState.commandLineText = context.commandLineText

        this.autoCompleter.clear(this.getCompletionBox());
        Persist.persistObjects(this, panelState);
        // more of our work is done in the Console
    },

    showPanel: function(browser, panel)
    {
        if (!Firebug.currentContext)
            return;

        var chrome = Firebug.chrome;
        var panelState = Persist.getPersistedState(this, "console");
        if (panelState.commandLineText)
        {
            var value = panelState.commandLineText;
            var commandLine = this.getCommandLine(browser);
            Firebug.currentContext.commandLineText = value;
            commandLine.value = value;

            // We don't need the persistent value in this session/context any more. The showPanel
            // method is called every time the panel is selected and the text could have been
            // changed in this session/context already.
            delete panelState.commandLineText;
        }

        this.autoCompleter.hide(this.getCompletionBox());
    },

    updateOption: function(name, value)
    {
        if (name == "commandEditor")
            this.setMultiLine(value, Firebug.chrome);
        else if (name == "commandLineShowCompleterPopup")
            this.setAutoCompleter();
    },

    // called by users of command line, currently:
    // 1) Console on focus command line, 2) Watch onfocus, and 3) debugger loadedContext if watches exist
    isReadyElsePreparing: function(context, win)
    {
        if (FBTrace.DBG_COMMANDLINE)
            FBTrace.sysout("commandLine.isReadyElsePreparing "+context.getName()+" win: "+
                (win?win.location:"not given"), context);

        if (this.isSandbox(context))
            return;

        if (Xml.isXMLPrettyPrint(context, win))
            return false;

        if (win)
        {
            Firebug.CommandLine.injector.attachCommandLine(context, win);
        }
        else
        {
            Firebug.CommandLine.injector.attachCommandLine(context, context.window);
            for (var i = 0; i < context.windows.length; i++)
                Firebug.CommandLine.injector.attachCommandLine(context, context.windows[i]);
        }

        var contentView = Wrapper.getContentView(context.window);
        if (!contentView)
        {
            if (FBTrace.DBG_ERRORS)
                FBTrace.sysout("CommandLine ERROR context.window invalid", context.window);
            return false;
        }

        // the attach is asynchronous, we can report when it is complete:
        return contentView._FirebugCommandLine;
    },

    onCommandLineKeyUp: function(event)
    {
        var commandLine = this.getCommandLine(Firebug.currentContext);
        var completionBox = this.getCompletionBox();

        //this.autoCompleter.handledKeyUp(event, Firebug.currentContext, commandLine, completionBox)
    },

    onCommandLineKeyDown: function(event)
    {
        if (event.keyCode === KeyEvent.DOM_VK_H && Events.isControl(event))
        {
            event.preventDefault();
            this.commandHistory.show(Firebug.chrome.$("fbCommandLineHistoryButton"));
            return true;
        }

        // Parts of the code moved into key-press handler due to bug 613752
    },

    onCommandLineKeyPress: function(event)
    {
        var commandLine = this.getCommandLine(Firebug.currentContext);
        var completionBox = this.getCompletionBox();

        if (!this.autoCompleter.handledKeyDown(event, Firebug.currentContext, commandLine, completionBox))
        {
            this.handledKeyDown(event);  // independent of completer
        }
    },

    handledKeyDown: function(event)
    {
        switch (event.keyCode)
        {
            case KeyEvent.DOM_VK_RETURN:
            case KeyEvent.DOM_VK_ENTER:
                event.preventDefault();
    
                if (!event.metaKey && !event.shiftKey)
                {
                    Firebug.CommandLine.enter(Firebug.currentContext);
                    handled = true;
                }
                else if (event.metaKey && !event.shiftKey)
                {
                    Firebug.CommandLine.enterMenu(Firebug.currentContext);
                    handled = true;
                }
                else if(event.shiftKey && !event.metaKey)
                {
                    Firebug.CommandLine.enterInspect(Firebug.currentContext);
                    handled = true;
                }
    
                if (handled)
                {
                    this.commandHistory.hide();
                    return true;
                }
                break;

            case KeyEvent.DOM_VK_UP:
                event.preventDefault();
                this.commandHistory.cycleCommands(Firebug.currentContext, -1);
                return true;

            case KeyEvent.DOM_VK_DOWN:
                event.preventDefault();
                this.commandHistory.cycleCommands(Firebug.currentContext, 1);
                return true;

            case KeyEvent.DOM_VK_ESCAPE:
                event.preventDefault();
                if (Firebug.CommandLine.cancel(Firebug.currentContext))
                    Events.cancelEvent(event);
                this.commandHistory.hide();
                return true;
        }

        return false;
    },

    onCommandLineInput: function(event)
    {
        var commandLine = this.getCommandLine(Firebug.currentContext);
        var completionBox = this.getCompletionBox();

        // Don't complete on empty command line
        if (!this.autoCompleter.getVerifiedText(commandLine))
        {
            this.autoCompleter.reset();
            this.autoCompleter.hide(this.getCompletionBox());
        }

        if (!this.commandHistory.isShown())
        {
            this.autoCompleter.complete(Firebug.currentContext, commandLine,
                completionBox, true, false);
        }

        // Always update the buffer in context, even if command line is empty.
        Firebug.currentContext.commandLineText = this.autoCompleter.getVerifiedText(commandLine);
    },

    onCommandLineBlur: function(event)
    {
        if (this.autoCompleter.linuxFocusHack)
            return;

        this.autoCompleter.clear(this.getCompletionBox());
    },

    onCommandLineFocus: function(event)
    {
        // xxxHonza: do we need to attach CMD API on focus?
        var context = Firebug.currentContext;
        if (this.autoCompleter && this.autoCompleter.linuxFocusHack)
            return;

        if (!Firebug.CommandLine.attachConsoleOnFocus())  // then there is no currentContext.
            return;

        if (!Firebug.migrations.commandLineTab)
        {
            var textBox = Firebug.chrome.$('fbCommandLine');
            textBox.value = "";
            textBox.select();
            Firebug.migrations.commandLineTab = true;
        }

        if (!Firebug.CommandLine.isAttached(Firebug.currentContext))
        {
            return Firebug.CommandLine.isReadyElsePreparing(Firebug.currentContext);
        }
        else
        {
            if (FBTrace.DBG_COMMANDLINE)
            {
                try
                {
                    var cmdLine = Firebug.CommandLine.isAttached(Firebug.currentContext);
                    FBTrace.sysout("commandLine.onCommandLineFocus, attachCommandLine "+cmdLine, cmdLine);
                }
                catch (e)
                {
                    FBTrace.sysout("commandLine.onCommandLineFocus, did NOT attachCommandLine ", e);
                }
            }
            return true; // is attached.
        }
    },

    isAttached: function(context, win)
    {
        if (!context)
            return false;

        return Firebug.CommandLine.injector.isAttached(win ? win : context.window);
    },

    attachConsoleOnFocus: function()
    {
        if (!Firebug.currentContext)
        {
            if (FBTrace.DBG_ERRORS && FBTrace.DBG_COMMANDLINE)
                FBTrace.sysout("commandLine.attachConsoleOnFocus no Firebug.currentContext");
            return false;
        }

        if (FBTrace.DBG_COMMANDLINE)
            FBTrace.sysout("commandLine.attachConsoleOnFocus: Firebug.currentContext is "+
                Firebug.currentContext.getName() + " in window "+window.location);

        // User has decided to use the command line, but the web page may not have the console
        // if the page has no javascript
        if (Firebug.Console.isReadyElsePreparing(Firebug.currentContext))
        {
            // the page had _firebug so we know that consoleInjected.js compiled and ran.
            if (FBTrace.DBG_COMMANDLINE)
            {
                if (Firebug.currentContext)
                    FBTrace.sysout("commandLine.attachConsoleOnFocus: "+Firebug.currentContext.getName());
                else
                    FBTrace.sysout("commandLine.attachConsoleOnFocus: No Firebug.currentContext\n");
            }
        }
        return true;
    },

    onPanelEnable: function(panelName)
    {
        Dom.collapse(Firebug.chrome.$("fbCommandBox"), true);
        Dom.collapse(Firebug.chrome.$("fbPanelSplitter"), true);
        Dom.collapse(Firebug.chrome.$("fbSidePanelDeck"), true);

        this.setMultiLine(Firebug.commandEditor, Firebug.chrome);
    },

    onPanelDisable: function(panelName)
    {
        if (panelName != 'console')  // we don't care about other panels
            return;

        Dom.collapse(Firebug.chrome.$("fbCommandBox"), true);
        Dom.collapse(Firebug.chrome.$("fbPanelSplitter"), true);
        Dom.collapse(Firebug.chrome.$("fbSidePanelDeck"), true);
    },

    // * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * *
    // Firebug.Console listener

    onConsoleInjected: function(context, win)
    {
        // for some reason the console has been injected. If the user had focus in the command
        // line they want it added in the page also. If the user has the cursor in the command
        // line and reloads, the focus will already be there. issue 1339
        var isFocused = (this.getCommandEditor().getAttribute("focused") == "true");
        isFocused = isFocused || (this.getSingleRowCommandLine().getAttribute("focused") == "true");
        if (isFocused)
            setTimeout(this.onCommandLineFocus);
    },

    getCommandLine: function(context)
    {
        // Command line on other panels is never multiline.
        var visible = Firebug.CommandLine.Popup.isVisible();
        if (visible && context.panelName != "console")
            return this.getSingleRowCommandLine();

        return Firebug.commandEditor
            ? this.getCommandEditor()
            : this.getSingleRowCommandLine();
    },

    getCompletionBox: function()
    {
        return Firebug.chrome.$("fbCommandLineCompletion");
    },

    getSingleRowCommandLine: function()
    {
        return Firebug.chrome.$("fbCommandLine");
    },

    getCommandEditor: function()
    {
        return Firebug.chrome.$("fbCommandEditor");
    }
});

// ************************************************************************************************
// Shared Helpers

Firebug.CommandLine.CommandHandler = Obj.extend(Object,
{
    handle: function(event, api, win)
    {
        var element = event.target;
        var methodName = win.document.getUserData("firebug-methodName");

        // We create this array in the page using JS, so we need to look on the wrappedJSObject for it.
        var contentView = Wrapper.getContentView(win);
        if (contentView)
            var hosed_userObjects = contentView._FirebugCommandLine.userObjects;

        var userObjects = hosed_userObjects ? Arr.cloneArray(hosed_userObjects) : [];

        if (FBTrace.DBG_COMMANDLINE)
            FBTrace.sysout("commandLine.CommandHandler for "+Win.getWindowId(win)+": method "+
                methodName+" userObjects:",  userObjects);

        var subHandler = api[methodName];
        if (!subHandler)
            return false;

        win.document.setUserData("firebug-retValueType", null, null);
        var result = subHandler.apply(api, userObjects);
        if (typeof result != "undefined")
        {
            if (result instanceof window.Array)
            {
                win.document.setUserData("firebug-retValueType", "array", null);
                for (var item in result)
                    hosed_userObjects.push(result[item]);
            }
            else
            {
                hosed_userObjects.push(result);
            }
        }

        return true;
    }
});

// ************************************************************************************************
// Local Helpers

function getExpressionOffset(command)
{
    // XXXjoe This is kind of a poor-man's JavaScript parser - trying
    // to find the start of the expression that the cursor is inside.
    // Not 100% fool proof, but hey...

    var bracketCount = 0;

    var start = command.length, instr = false;

    // When completing []-accessed properties, start instead from the last [.
    var lastBr = command.lastIndexOf("[");
    if (lastBr !== -1 && /^['"] *$/.test(command.substr(lastBr+1)))
        start = lastBr;

    while (start --> 0)
    {
        var c = command[start];
        if (reOpenBracket.test(c))
        {
            if (bracketCount)
                --bracketCount;
            else
                break;
        }
        else if (reCloseBracket.test(c))
        {
            var next = command[start + 1];
            if (bracketCount === 0 && next !== '.' && next !== '[')
                break;
            else
                ++bracketCount;
        }
        else if (bracketCount === 0)
        {
            if (c === '"') instr = !instr;
            else if (!instr && !reJSChar.test(c) && c !== '.')
                break;
        }
    }

    return start + 1;
}

function getRange(expr, offset)
{
    var lastBr = expr.lastIndexOf("[");
    if (lastBr !== -1 && /^['"] *$/.test(expr.substr(lastBr+1)))
        return {start: lastBr+2, end: expr.length-1};

    var lastDot = expr.lastIndexOf(".");
    if (lastDot !== -1)
        return {start: lastDot+1, end: expr.length-1};

    return null;
}

// Get the index of the last non-whitespace character in the range [0, from)
// in str, or -1 if none.
function prevNonWs(str, from)
{
    while (from --> 0)
    {
        if (str.charAt(from) !== ' ')
            return from;
    }
    return -1;
}

function prevWord(str, from)
{
    while (from --> 0)
    {
        if (!reJSChar.test(str.charAt(from)))
            break;
    }
    return from + 1;
}

function isFunctionName(expr, pos)
{
    pos -= 9;
    return (pos >= 0 && expr.substr(pos, 9) === 'function ' &&
            (pos === 0 || !reJSChar.test(expr.charAt(pos-1))));
}

function bwFindMatchingParen(expr, from)
{
    var bcount = 1;
    while (from --> 0)
    {
        if (reCloseBracket.test(expr.charAt(from)))
            ++bcount;
        else if (reOpenBracket.test(expr.charAt(from)))
            if (--bcount === 0)
                return from;
    }
    return -1;
}

// Check if a '/' at the end of 'expr' would be a regex or a division.
// May also return null if the expression seems invalid.
function endingDivIsRegex(expr)
{
    var kwActions = ['throw', 'return', 'in', 'instanceof', 'delete', 'new',
        'do', 'else', 'typeof', 'void', 'yield'];
    var kwCont = ['function', 'if', 'while', 'for', 'switch', 'catch', 'with'];

    var ind = prevNonWs(expr, expr.length), ch = (ind === -1 ? '{' : expr.charAt(ind));
    if (reJSChar.test(ch))
    {
        // Test if the previous word is a keyword usable like 'kw <expr>'.
        // If so, we have a regex, otherwise, we have a division (a variable
        // or literal being divided by something).
        var w = expr.substring(prevWord(expr, ind), ind+1);
        return (kwActions.indexOf(w) !== -1);
    }
    else if (ch === ')')
    {
        // We have a regex in the cases 'if (...) /blah/' and 'function name(...) /blah/'.
        ind = bwFindMatchingParen(expr, ind);
        if (ind === -1)
            return null;
        ind = prevNonWs(expr, ind);
        if (ind === -1)
            return false;
        if (!reJSChar.test(expr.charAt(ind)))
            return false;
        var wind = prevWord(expr, ind);
        if (kwCont.indexOf(expr.substring(wind, ind+1)) !== -1)
            return true;
        return isFunctionName(expr, wind);
    }
    else if (ch === ']')
        return false;
    else return true;
}

// Check if a '{' in an expression is an object declaration.
function isObjectDecl(expr, pos)
{
    var ind = prevNonWs(expr, pos);
    if (ind === -1)
        return false;
    var ch = expr.charAt(ind);
    return !(ch === ')' || ch === '{' || ch === '}' || ch === ';');
}

function isCommaProp(expr, start)
{
    var beg = expr.lastIndexOf(',')+1;
    if (beg < start)
        beg = start;
    while (expr.charAt(beg) === ' ')
        ++beg;
    var prop = expr.substr(beg);
    return isValidProperty(prop);
}

function simplifyExpr(expr)
{
    var ret = '', len = expr.length, instr = false, strend, inreg = false, inclass, brackets = [];

    for (var i = 0; i < len; ++i)
    {
        var ch = expr.charAt(i);
        if (instr)
        {
            if (ch === strend)
            {
                ret += '"';
                instr = false;
            }
            else
            {
                if (ch === '\\' && i+1 !== len)
                {
                    ret += ' ';
                    ++i;
                }
                ret += ' ';
            }
        }
        else if (inreg)
        {
            if (inclass && ch === ']')
                inclass = false;
            else if (!inclass && ch === '[')
                inclass = true;
            else if (!inclass && ch === '/')
            {
                // End of regex, eat regex flags
                inreg = false;
                while (i+1 !== len && reJSChar.test(expr.charAt(i+1)))
                {
                    ret += ' ';
                    ++i;
                }
                ret += '"';
            }
            if (inreg)
            {
                if (ch === '\\' && i+1 !== len)
                {
                    ret += ' ';
                    ++i;
                }
                ret += ' ';
            }
        }
        else
        {
            if (ch === "'" || ch === '"')
            {
                instr = true;
                strend = ch;
                ret += '"';
            }
            else if (ch === '/')
            {
                var re = endingDivIsRegex(ret);
                if (re === null)
                    return null;
                if (re)
                {
                    inreg = true;
                    ret += '"';
                }
                else
                    ret += '/';
            }
            else
            {
                if (reOpenBracket.test(ch))
                    brackets.push(ch);
                else if (reCloseBracket.test(ch))
                {
                    // Check for mismatched brackets
                    if (!brackets.length)
                        return null;
                    var br = brackets.pop();
                    if (br === '(' && ch !== ')')
                        return null;
                    if (br === '[' && ch !== ']')
                        return null;
                    if (br === '{' && ch !== '}')
                        return null;
                }
                ret += ch;
            }
        }
    }

    return ret;
}

// Check if auto-completion should be killed.
function killCompletions(expr)
{
    // Check for 'function i'.
    var ind = expr.lastIndexOf(' ');
    if (isValidProperty(expr.substr(ind+1)) && isFunctionName(expr, ind+1))
        return true;

    // Check for '{prop: ..., i'.
    var bwp = bwFindMatchingParen(expr, expr.length);
    if (bwp !== -1 && expr.charAt(bwp) === '{' &&
            isObjectDecl(expr, bwp) && isCommaProp(expr, bwp+1))
    {
        return true;
    }

    // Check for 'var prop..., i'.
    var vind = expr.lastIndexOf('var ');
    if (bwp < vind && isCommaProp(expr, vind+4))
    {
        // Note: This doesn't strictly work, because it kills completions even
        // when we have started a new expression and used the comma operator
        // in it (ie. 'var a; a, i'). This happens very seldom though, so it's
        // not really a problem.
        return true;
    }

    // Check for 'function f(i'.
    while (bwp !== -1 && expr.charAt(bwp) !== '(')
    {
        bwp = bwFindMatchingParen(expr, bwp);
    }
    if (bwp !== -1)
    {
        var ind = prevNonWs(expr, bwp);
        if (ind !== -1)
        {
            var stw = prevWord(expr, ind);
            if (expr.substring(stw, ind+1) === 'function')
                return true;
            ind = prevNonWs(expr, stw);
            if (ind !== -1 && expr.substring(prevWord(expr, ind), ind+1) === 'function')
                return true;
        }
    }
    return false;
}

function adjustCompletion(completion, preParsed, preExpr)
{
    // Don't adjust index completions.
    if (/^\[['"]$/.test(preExpr.slice(-2)))
        return completion;

    var preLength = preParsed.length + preExpr.length;
    var property = completion.substr(preLength);
    if (!isValidProperty(property))
    {
        // The property name is actually invalid in free form, so replace
        // it with array syntax.

        if (preLength > 0 && completion.charAt(preLength-1) === ".")
        {
            completion = completion.substr(0, preLength-1);
        }
        else
        {
            // Global variable access - assume the variable is a member of
            // 'window' and not of some object made global by a with-
            // statement (which we can't really access anyway).
            completion = completion.substr(0, preLength) + "window";
        }
        completion += '["' + Str.escapeJS(property) + '"]';
    }
    return completion;
}

// Types the autocompletion knows about, some of their non-enumerable properties,
// and the return types of some member functions, included in the Firebug.CommandLine
// object to make it more easily extensible.
// XXXsilin Would this be better placed in the declaration list of Firebug.CommandLine?
// xxxHonza: what do you mean by the declaratio list?

Firebug.CommandLine.AutoCompletionKnownTypes = {
    'void': {
        '_fb_ignorePrototype': true
    },
    'Array': {
        'pop': '|void',
        'push': '|void',
        'shift': '|void',
        'unshift': '|void',
        'reverse': '|Array',
        'sort': '|Array',
        'splice': '|Array',
        'concat': '|Array',
        'slice': '|Array',
        'join': '|String',
        'indexOf': '|void',
        'lastIndexOf': '|void',
        'filter': '|Array',
        'map': '|Array',
        'reduce': '|void',
        'reduceRight': '|void',
        'every': '|void',
        'forEach': '|void',
        'some': '|void',
        'length': 'void'
    },
    'String': {
        '_fb_contType': 'String',
        'split': '|Array',
        'substr': '|String',
        'substring': '|String',
        'charAt': '|String',
        'charCodeAt': '|String',
        'concat': '|String',
        'indexOf': '|void',
        'lastIndexOf': '|void',
        'localeCompare': '|void',
        'match': '|Array',
        'search': '|void',
        'slice': '|String',
        'replace': '|String',
        'toLowerCase': '|String',
        'toLocaleLowerCase': '|String',
        'toUpperCase': '|String',
        'toLocaleUpperCase': '|String',
        'trim': '|String',
        'length': 'void'
    },
    'RegExp': {
        'test': '|void',
        'exec': '|Array',
        'lastIndex': 'void',
        'ignoreCase': 'void',
        'global': 'void',
        'multiline': 'void',
        'source': 'String'
    },
    'Date': {
        'getTime': '|void',
        'getYear': '|void',
        'getFullYear': '|void',
        'getMonth': '|void',
        'getDate': '|void',
        'getDay': '|void',
        'getHours': '|void',
        'getMinutes': '|void',
        'getSeconds': '|void',
        'getMilliseconds': '|void',
        'getUTCFullYear': '|void',
        'getUTCMonth': '|void',
        'getUTCDate': '|void',
        'getUTCDay': '|void',
        'getUTCHours': '|void',
        'getUTCMinutes': '|void',
        'getUTCSeconds': '|void',
        'getUTCMilliseconds': '|void',
        'setTime': '|void',
        'setYear': '|void',
        'setFullYear': '|void',
        'setMonth': '|void',
        'setDate': '|void',
        'setHours': '|void',
        'setMinutes': '|void',
        'setSeconds': '|void',
        'setMilliseconds': '|void',
        'setUTCFullYear': '|void',
        'setUTCMonth': '|void',
        'setUTCDate': '|void',
        'setUTCHours': '|void',
        'setUTCMinutes': '|void',
        'setUTCSeconds': '|void',
        'setUTCMilliseconds': '|void',
        'toUTCString': '|String',
        'toLocaleDateString': '|String',
        'toLocaleTimeString': '|String',
        'toLocaleFormat': '|String',
        'toDateString': '|String',
        'toTimeString': '|String',
        'toISOString': '|String',
        'toGMTString': '|String',
        'toJSON': '|String',
        'toString': '|String',
        'toLocaleString': '|String',
        'getTimezoneOffset': '|void'
    },
    'Function': {
        'call': '|void',
        'apply': '|void',
        'length': 'void'
    },
    'HTMLElement': {
        'getElementsByClassName': '|NodeList',
        'getElementsByTagName': '|NodeList',
        'getElementsByTagNameNS': '|NodeList',
        'querySelector': '|HTMLElement',
        'querySelectorAll': '|NodeList',
        'firstChild': 'HTMLElement',
        'lastChild': 'HTMLElement',
        'firstElementChild': 'HTMLElement',
        'lastElementChild': 'HTMLElement',
        'parentNode': 'HTMLElement',
        'previousSibling': 'HTMLElement',
        'nextSibling': 'HTMLElement',
        'previousElementSibling': 'HTMLElement',
        'nextElementSibling': 'HTMLElement',
        'children': 'NodeList',
        'childNodes': 'NodeList'
    },
    'NodeList': {
        '_fb_contType': 'HTMLElement',
        'length': 'void',
        'item': '|HTMLElement'
    },
    'Window': {
        'encodeURI': '|String',
        'encodeURIComponent': '|String',
        'decodeURI': '|String',
        'decodeURIComponent': '|String',
        'eval': '|void'
    },
    'HTMLDocument': {
        'getElementsByClassName': '|NodeList',
        'getElementsByTagName': '|NodeList',
        'getElementsByTagNameNS': '|NodeList',
        'querySelector': '|HTMLElement',
        'querySelectorAll': '|NodeList',
        'getElementById': '|HTMLElement'
    }
};

function getKnownType(t)
{
    var known = Firebug.CommandLine.AutoCompletionKnownTypes;
    if (known.hasOwnProperty(t))
        return known[t];
    return null;
}

function getKnownTypeInfo(r)
{
    if (typeof r !== 'string')
        return r;
    if (r.charAt(0) === '|')
        return {'val': 'Function', 'ret': {'val': r.substr(1)}};
    return {'val': r};
}

function getFakeCompleteKeys(name)
{
    var ret = [], type = getKnownType(name);
    if (!type)
        return ret;
    for (var prop in type) {
        if (prop.substr(0, 4) !== '_fb_' && !type[prop].splice)
            ret.push(prop);
    }
    return ret;
}

function eatProp(expr, start)
{
    for (var i = start; i < expr.length; ++i)
        if (!reJSChar.test(expr.charAt(i)))
            break;
    return i;
}

function matchingBracket(expr, start)
{
    var count = 1;
    for (var i = start + 1; i < expr.length; ++i) {
        var ch = expr.charAt(i);
        if (reOpenBracket.test(ch))
            ++count;
        else if (reCloseBracket.test(ch))
            if (!--count)
                return i;
    }
    return -1;
}

function getTypeExtractionExpression(command)
{
    // Return a JavaScript expression for determining the type of an object
    // given by another JavaScript expression. For DOM nodes, return HTMLElement
    // instead of HTML[node type]Element, for simplicity.
    var ret = '(function() { var v = ' + command + '; ';
    ret += 'if (window.HTMLElement && v instanceof HTMLElement) return "HTMLElement"; ';
    ret += 'var cr = Object.prototype.toString.call(v).slice(8, -1); ';
    ret += 'if (v instanceof window[cr] || v === window[cr].prototype) return cr;})()';
    return ret;
}

function propChainBuildComplete(out, context, tempExpr, result)
{
    var complete = null, command = null;
    if (tempExpr.type === 'fake')
    {
        var name = tempExpr.value.val;
        complete = getFakeCompleteKeys(name);
        if (!getKnownType(name)._fb_ignorePrototype)
            command = name + '.prototype';
    }
    else
    {
        // XXXsilin Why isn't Object.getOwnPropertyNames used when supported?
        if (typeof result === 'string')
        {
            // Strings only have indices as properties, use the fake object
            // completions instead.
            tempExpr.type = 'fake';
            tempExpr.value = getKnownTypeInfo('String');
            propChainBuildComplete(out, context, tempExpr);
            return;
        }
        else if (FirebugReps.Arr.isArray(result))
            complete = nonNumericKeys(result);
        else
            complete = Arr.keys(result);
        command = getTypeExtractionExpression(tempExpr.command);
    }

    var done = function()
    {
        complete.sort();
        var resComplete = [];
        // Properties may be taken from several sources, so filter out duplicates.
        for (var i = 0; i < complete.length; ++i)
        {
            if (!i || complete[i-1] !== complete[i])
                resComplete.push(complete[i]);
        }

        if (out.indexCompletion)
        {
            resComplete = resComplete.map(function(x)
            {
                x = (out.indexQuoteType === '"') ? Str.escapeJS(x): Str.escapeSingleQuoteJS(x);
                return x + out.indexQuoteType + "]";
            });
        }
        out.complete = resComplete;
    };

    if (command === null)
        done();
    else
    {
        Firebug.CommandLine.evaluate(command, context, context.thisValue, null,
            function found(result, context)
            {
                if (tempExpr.type === 'fake')
                {
                    complete = complete.concat(Arr.keys(result));
                }
                else
                {
                    // XXXsilin Is using userland strings safe?
                    if (typeof result === 'string' && getKnownType(result))
                    {
                        complete = complete.concat(getFakeCompleteKeys(result));
                    }
                }
                done();
            },
            function failed(result, context)
            {
                done();
            }
        );
    }
}

function evalPropChainStep(step, tempExpr, evalChain, out, context)
{
    if (tempExpr.type === 'fake')
    {
        if (step === evalChain.length)
        {
            propChainBuildComplete(out, context, tempExpr);
            return;
        }

        var link = evalChain[step], type = link.type;
        if (type === 'property' || type === 'index')
        {
            // Use the accessed property if it exists and is unique (in case
            // of multiple-definition functions), otherwise abort. It would
            // be possible to continue with a 'real' expression of
            // `tempExpr.value.val`.prototype, but since prototypes seldom
            // contain actual values of things this doesn't work very well.
            var mem = (type === 'index' ? '_fb_contType' : link.name);
            var t = getKnownType(tempExpr.value.val);
            if (t.hasOwnProperty(mem) && !t[mem].splice)
                tempExpr.value = getKnownTypeInfo(t[mem]);
            else
                return;
        }
        else if (type === 'call')
        {
            if (tempExpr.value.ret)
                tempExpr.value = tempExpr.value.ret;
            else
                return;
        }
        evalPropChainStep(step+1, tempExpr, evalChain, out, context);
    }
    else
    {
        var funcCommand = null, link, type;
        while (step !== evalChain.length)
        {
            link = evalChain[step];
            type = link.type;
            if (type === 'property')
            {
                tempExpr.thisCommand = tempExpr.command;
                tempExpr.command += '.' + link.name;
            }
            else if (type === 'index')
            {
                tempExpr.thisCommand = 'window';
                tempExpr.command += '[' + link.cont + ']';
            }
            else if (type === 'safecall')
            {
                tempExpr.thisCommand = 'window';
                tempExpr.command += '(' + link.cont + ')';
            }
            else if (type === 'call')
            {
                if (link.name === '')
                {
                    // We cannot know about functions without name, try the
                    // heuristic directly.
                    link.type = 'retval-heuristic';
                    evalPropChainStep(step, tempExpr, evalChain, out, context);
                    return;
                }

                funcCommand = getTypeExtractionExpression(tempExpr.thisCommand);
                break;
            }
            else if (type === 'retval-heuristic')
            {
                if (link.name.substr(0, 3) === 'get' && link.cont !== null)
                {
                    // Names beginning with get are almost always getters, so
                    // assume the it is a safecall and start over.
                    // XXXsilin This feels like a good compromise to me. Is
                    // it okay to make an exception like this?
                    link.type = 'safecall';
                    evalPropChainStep(step, tempExpr, evalChain, out, context);
                    return;
                }
                funcCommand = 'Function.prototype.toString.call(' + tempExpr.command + ')';
                break;
            }
            ++step;
        }

        var func = (funcCommand !== null), command = (func ? funcCommand : tempExpr.command);
        Firebug.CommandLine.evaluate(command, context, context.thisValue, null,
            function found(result, context)
            {
                if (func)
                {
                    // XXXsilin Is using userland values of types 'number' and 'string' safe?
                    if (type === 'call')
                    {
                        if (typeof result !== 'string')
                            return;

                        var t = getKnownType(result);
                        if (t && t.hasOwnProperty(link.name))
                        {
                            var propVal = getKnownTypeInfo(t[link.name]);

                            // Make sure the property is a callable function
                            if (!propVal.ret)
                                return;

                            tempExpr.type = 'fake';
                            tempExpr.value = getKnownTypeInfo(propVal.ret);
                            evalPropChainStep(step+1, tempExpr, evalChain, out, context);
                        }
                        else
                        {
                            // Unknown 'this' type or function name, use
                            // heuristics on the function instead.
                            link.type = 'retval-heuristic';
                            evalPropChainStep(step, tempExpr, evalChain, out, context);
                        }
                    }
                    else if (type === 'retval-heuristic')
                    {
                        if (typeof result !== 'string')
                            return;

                        // Perform some crude heuristics for figuring out the
                        // return value of a function based on its contents.
                        // It's certainly not perfect, and it's easily fooled
                        // into giving wrong results,  but it might work in
                        // some common cases.

                        // Don't support nested functions.
                        if (result.lastIndexOf('function ') !== 0)
                            return;

                        // Check for chaining functions.
                        if (result.indexOf('return this;') !== -1)
                        {
                            tempExpr.command = tempExpr.thisCommand;
                            tempExpr.thisCommand = 'window';
                            evalPropChainStep(step+1, tempExpr, evalChain, out, context);
                            return;
                        }

                        // Check for 'return new Type(...);', and use the
                        // prototype as a pseudo-object for those (since it
                        // is probably not a known type that we can fake).
                        var newPos = result.indexOf('return new ');
                        if (newPos !== -1)
                        {
                            var rest = result.substr(newPos + 11),
                                epos = rest.search(/[^a-zA-Z0-9_$.]/);
                            if (epos !== -1)
                            {
                                rest = rest.substring(0, epos);
                                tempExpr.command = rest + '.prototype';
                                evalPropChainStep(step+1, tempExpr, evalChain, out, context);
                                return;
                            }
                        }
                    }
                }
                else
                {
                    propChainBuildComplete(out, context, tempExpr, result);
                }
            },
            function failed(result, context) { }
        );
    }
}

function evalPropChain(self, preExpr, origExpr, context)
{
    var evalChain = [], linkStart = 0, len = preExpr.length, lastProp = '';
    var tempExpr = {'type': 'real', 'command': 'window', 'thisCommand': 'window'};
    while (linkStart !== len)
    {
        var ch = preExpr.charAt(linkStart);
        if (linkStart === 0)
        {
            if (ch === '[')
            {
                tempExpr.type = 'fake';
                tempExpr.value = {'val': 'Array'};
                linkStart = matchingBracket(preExpr, linkStart) + 1;
                if (linkStart === 0)
                    return false;
            }
            else if (ch === '"')
            {
                var isRegex = (origExpr.charAt(0) === '/');
                tempExpr.type = 'fake';
                tempExpr.value = {'val': (isRegex ? 'RegExp' : 'String')};
                linkStart = preExpr.indexOf('"', 1) + 1;
                if (linkStart === 0)
                    return false;
            }
            else if (ch === '(' || ch === '{')
            {
                // Expression either looks like '(...).prop', which is
                // too complicated, or '{...}.prop', which is uncommon
                // and thus pointless to implement.
                return false;
            }
            else if (reJSChar.test(ch))
            {
                // The expression begins with a regular property name
                var nextLink = eatProp(preExpr, linkStart);
                lastProp = preExpr.substring(linkStart, nextLink);
                linkStart = nextLink;
                evalChain.push({'type': 'property', 'name': lastProp});
            }
            else
            {
                // Syntax error, like '.'.
                return false;
            }
        }
        else
        {
            if (ch === '.')
            {
                // Property access
                var nextLink = eatProp(preExpr, linkStart+1);
                lastProp = preExpr.substring(linkStart+1, nextLink);
                linkStart = nextLink;
                evalChain.push({'type': 'property', 'name': lastProp});
            }
            else if (ch === '(')
            {
                // Function call. Save the function name and the arguments if
                // they are safe to evaluate.
                var endCont = matchingBracket(preExpr, linkStart);
                var cont = preExpr.substring(linkStart+1, endCont);
                if (reLiteralExpr.test(cont))
                    cont = origExpr.substring(linkStart+1, endCont);
                else
                    cont = null;
                linkStart = endCont + 1;
                evalChain.push({'type': 'call', 'name': lastProp, 'cont': cont});
                lastProp = '';
            }
            else if (ch === '[')
            {
                // Index. Use the supplied index if it is a literal; otherwise
                // it is probably a loop index with a variable not yet defined
                // (like 'for(var i = 0; i < ar.length; ++i) ar[i].prop'), and
                // '0' seems like a reasonably good guess at a valid index.
                var endInd = matchingBracket(preExpr, linkStart);
                var ind = preExpr.substring(linkStart+1, endInd);
                if (reLiteralExpr.test(ind))
                    ind = origExpr.substring(linkStart+1, endInd);
                else
                    ind = '0';
                linkStart = endInd+1;
                evalChain.push({'type': 'index', 'cont': ind});
                lastProp = '';
            }
            else
            {
                // Syntax error
                return false;
            }
        }
    }

    evalPropChainStep(0, tempExpr, evalChain, self, context);
    return true;
}

function autoCompleteEval(preExpr, expr, postExpr, context, spreExpr)
{
    var completions;

    try
    {
        if (spreExpr)
        {
            // In case of array indexing, remove the bracket and set a flag to
            // escape completions.
            this.indexCompletion = false;
            var len = spreExpr.length, lastCh = spreExpr[len-1];
            if (len >= 2 && spreExpr[len-2] === "[" && spreExpr[len-1] === '"')
            {
                this.indexCompletion = true;
                this.indexQuoteType = preExpr[len-1];
                spreExpr = spreExpr.substr(0, len-2);
                preExpr = preExpr.substr(0, len-2);
            }
            else
            {
                // Remove the trailing dot (if there is one)
                var lastDot = spreExpr.lastIndexOf(".");
                if (lastDot !== -1)
                {
                    spreExpr = spreExpr.substr(0, lastDot);
                    preExpr = preExpr.substr(0, lastDot);
                }
            }

            this.complete = [];

            if (FBTrace.DBG_COMMANDLINE)
                FBTrace.sysout("commandLine.autoCompleteEval pre:'" + preExpr +
                    "' spre:'" + spreExpr + "'.");

            // Don't auto-complete '.'.
            if (spreExpr === '')
                return this.complete;

            evalPropChain(this, spreExpr, preExpr, context);
            return this.complete;
        }
        else
        {
            // XXXsilin Why is this so entirely different from the above? The only real
            // change I can see is the addition of keywords; other than that wouldn't
            // running the above code with preExpr = spreExpr = 'window.' work?
            // (Help! It looks scary.)

            if (context.stopped)
                return Firebug.Debugger.getCurrentFrameKeys(context);

            // Cross window type pseudo-comparison
            var contentView = Wrapper.getContentView(context.window);
            if (contentView && contentView.Window &&
                contentView.constructor.toString() === contentView.Window.toString())
            {
                // XXXsilin I assume keys(innerWindow)? I'm not familiar enough with
                // wrapped objects to change it.
                completions = Arr.keys(contentView); // return is safe

                // Add some known window properties, without duplicates.
                completions = completions.concat(getFakeCompleteKeys('Window'));
                var dupCompletions = completions.sort();
                completions = [];
                for (var i = 0; i < dupCompletions.length; ++i)
                {
                    if (!i || dupCompletions[i-1] !== dupCompletions[i])
                        completions.push(dupCompletions[i]);
                }
            }
            else  // hopefull sandbox in Chromebug
                completions = Arr.keys(context.global);

            // XXXsilin Is this still necessary, now that '(' doesn't autocomplete?
            // It does help '...; return<CR>' if variables beginning with 'return'
            // exist, but I'm not even sure that's a good use case.
            addMatchingKeyword(expr, completions);

            return completions.sort();
        }
    }
    catch (exc)
    {
        if (FBTrace.DBG_ERRORS && FBTrace.DBG_COMMANDLINE)
            FBTrace.sysout("commandLine.autoCompleteEval FAILED", exc);
        return [];
    }
}

var reValidJSToken = /^[A-Za-z_$][A-Za-z_$0-9]*$/;
function isValidProperty(value)
{
    // Use only string props
    if (typeof(value) != "string")
        return false;

    // Use only those props that don't contain unsafe charactes and so need
    // quotation (e.g. object["my prop"] notice the space character).
    // Following expression checks that the name starts with a letter or $_,
    // and there are only letters, numbers or $_ character in the string (no spaces).

    return reValidJSToken.test(value);
}

function addMatchingKeyword(expr, completions)
{
    if (Keywords.isJavaScriptKeyword(expr))
        completions.push(expr);
}

function injectScript(script, win)
{
    win.location = "javascript: " + script;
}

// XXXsilin only cover positive numbers
const rePositiveNumber = /^[1-9][0-9]*$/;
function nonNumericKeys(map)  // At least sometimes the keys will be on user-level window objects
{
    var keys = [];
    try
    {
        for (var name in map)  // enumeration is safe
        {
            // XXXsilin Wait, what? "number" seems like a typo for "Number", and
            // I'm also pretty sure numeric indices are strings, not numbers (when
            // traversed as properties) - even if they were, they propably wouldn't
            // be proper objects and so not instances of anything). AFAICT, this
            // breaks completion for arrays and jQuery objects.
            // Changing this for now, but do look over it because I'm not sure if
            // it's safe.
            // if (! (name instanceof number) )
                // keys.push(name);   // name is string, safe

            if (! (name === '0' || rePositiveNumber.test(name)) )
                keys.push(name);
        }
    }
    catch (exc)
    {
        // Sometimes we get exceptions trying to iterate properties
    }

    return keys;  // return is safe
};

// ************************************************************************************************
// Command line APIs definition
//
// These functions will be called in the extension like this:
//   subHandler.apply(api, userObjects);
// where subHandler is one of the entries below, api is this object and userObjects are entries in
// an array we created in the web page.

function FirebugCommandLineAPI(context)
{
    this.$ = function(id)  // returns unwrapped elements from the page
    {
        return Wrapper.unwrapObject(context.baseWindow.document).getElementById(id);
    };

    this.$$ = function(selector) // returns unwrapped elements from the page
    {
        var result = Wrapper.unwrapObject(context.baseWindow.document).querySelectorAll(selector);
        return Arr.cloneArray(result);
    };

    this.$x = function(xpath) // returns unwrapped elements from the page
    {
        return Xpath.getElementsByXPath(Wrapper.unwrapObject(context.baseWindow.document), xpath);
    };

    this.$n = function(index) // values from the extension space
    {
        var htmlPanel = context.getPanel("html", true);
        if (!htmlPanel)
            return null;

        if (index < 0 || index >= htmlPanel.inspectorHistory.length)
            return null;

        var node = htmlPanel.inspectorHistory[index];
        if (!node)
            return node;

        return Wrapper.unwrapObject(node);
    };

    this.cd = function(object)
    {
        if (!(object instanceof window.Window))
            throw "Object must be a window.";

        // Make sure the command line is attached into the target iframe.
        var consoleReady = Firebug.Console.isReadyElsePreparing(context, object);
        if (FBTrace.DBG_COMMANDLINE)
            FBTrace.sysout("commandLine.cd; console ready: " + consoleReady);

        // The window object parameter uses XPCSafeJSObjectWrapper, but we need XPCNativeWrapper
        // So, look within all registered consoleHandlers for
        // the same window (from tabWatcher) that uses uses XPCNativeWrapper (operator "==" works).
        var entry = Firebug.Console.injector.getConsoleHandler(context, object);
        if (entry)
            context.baseWindow = entry.win;

        Firebug.Console.log(["Current window:", context.baseWindow], context, "info");
        return "_firebugIgnore";
    };

    this.clear = function()  // no web page interaction
    {
        Firebug.Console.clear(context);
        return "_firebugIgnore";
    };

    this.inspect = function(obj, panelName)  // no web page interaction
    {
        Firebug.chrome.select(obj, panelName);
        return "_firebugIgnore";
    };

    this.keys = function(o)
    {
        return Arr.keys(o);  // the object is from the page, unwrapped
    };

    this.values = function(o)
    {
        return Arr.values(o); // the object is from the page, unwrapped
    };

    this.debug = function(fn)
    {
        Firebug.Debugger.monitorFunction(fn, "debug");
        return "_firebugIgnore";
    };

    this.undebug = function(fn)
    {
        Firebug.Debugger.unmonitorFunction(fn, "debug");
        return "_firebugIgnore";
    };

    this.monitor = function(fn)
    {
        Firebug.Debugger.monitorFunction(fn, "monitor");
        return "_firebugIgnore";
    };

    this.unmonitor = function(fn)
    {
        Firebug.Debugger.unmonitorFunction(fn, "monitor");
        return "_firebugIgnore";
    };

    this.traceAll = function()
    {
        Firebug.Debugger.traceAll(Firebug.currentContext);
        return "_firebugIgnore";
    };

    this.untraceAll = function()
    {
        Firebug.Debugger.untraceAll(Firebug.currentContext);
        return "_firebugIgnore";
    };

    this.traceCalls = function(fn)
    {
        Firebug.Debugger.traceCalls(Firebug.currentContext, fn);
        return "_firebugIgnore";
    };

    this.untraceCalls = function(fn)
    {
        Firebug.Debugger.untraceCalls(Firebug.currentContext, fn);
        return "_firebugIgnore";
    };

    this.monitorEvents = function(object, types)
    {
        EventMonitor.monitorEvents(object, types, context);
        return "_firebugIgnore";
    };

    this.unmonitorEvents = function(object, types)
    {
        EventMonitor.unmonitorEvents(object, types, context);
        return "_firebugIgnore";
    };

    this.profile = function(title)
    {
        Firebug.Profiler.startProfiling(context, title);
        return "_firebugIgnore";
    };

    this.profileEnd = function()
    {
        Firebug.Profiler.stopProfiling(context);
        return "_firebugIgnore";
    };

    this.copy = function(x)
    {
        System.copyToClipboard(x);
        return "_firebugIgnore";
    };

    this.memoryProfile = function(title)
    {
        Firebug.MemoryProfiler.start(context, title);
        return "_firebugIgnore";
    };

    this.memoryProfileEnd = function()
    {
        Firebug.MemoryProfiler.stop(context);
        return "_firebugIgnore";
    };
}

// ************************************************************************************************

Firebug.CommandLine.CommandHistory = function()
{
    const commandHistoryMax = 1000;

    var commandsPopup = Firebug.chrome.$("fbCommandHistory");
    var commands = [];
    var commandPointer = 0;
    var commandInsertPointer = -1;

    this.getLastCommand = function()
    {
        var command = commands[commandInsertPointer];
        if (!command)
            return "";
        return command;
    };

    this.appendToHistory = function(command)
    {
        if (commands[commandInsertPointer] != command)
        {
            commandInsertPointer++;
            if (commandInsertPointer >= commandHistoryMax)
                commandInsertPointer = 0;

            commands[commandInsertPointer] = command;
        }
        commandPointer = commandInsertPointer + 1;

        if (Firebug.chrome.$("fbCommandLineHistoryButton").hasAttribute("disabled"))
        {
            Firebug.chrome.$("fbCommandLineHistoryButton").removeAttribute("disabled");
            Firebug.chrome.$("fbCommandEditorHistoryButton").removeAttribute("disabled");
            commandsPopup.addEventListener("mouseover", this.onMouseOver, true);
            commandsPopup.addEventListener("mouseup", this.onMouseUp, true);
            commandsPopup.addEventListener("popuphidden", this.onPopupHidden, true);
        }
    };

    this.cycleCommands = function(context, dir)
    {
        var command,
            commandLine = Firebug.CommandLine.getCommandLine(context);

        if (dir < 0)
        {
            if (commandPointer > 0)
                commandPointer--;
        }
        else if (commandPointer < commands.length)
            commandPointer++;

        if (commandPointer < commands.length)
        {
            command =  commands[commandPointer];
            if (commandsPopup.state == "open")
            {
                var commandElements = commandsPopup.ownerDocument.getElementsByClassName(
                    "commandHistoryItem");
                this.selectCommand(commandElements[commandPointer]);
            }
        }
        else
        {
            command =  "";
            this.removeCommandSelection();
        }

        commandLine.value = context.commandLineText = command;

        Firebug.CommandLine.setCursor(commandLine, command.length);
    };

    this.isShown = function() {
        return commandsPopup.state == "open";
    };

    this.show = function(element) {
        if (this.isShown())
            return this.hide;

        Dom.eraseNode(commandsPopup);

        if(commands.length == 0)
            return;

        var vbox = commandsPopup.ownerDocument.createElement("vbox");

        for (var i = 0; i < commands.length; i++)
        {
            var hbox = commandsPopup.ownerDocument.createElementNS("http://www.w3.org/1999/xhtml", "div");

            hbox.classList.add("commandHistoryItem");
            var shortExpr = Str.cropString(Str.stripNewLines(commands[i]), 50);
            hbox.innerHTML = Str.escapeForTextNode(shortExpr);
            hbox.value = i;
            vbox.appendChild(hbox);

            if (i === commandPointer)
                this.selectCommand(hbox);
        }

        commandsPopup.appendChild(vbox);
        commandsPopup.openPopup(element, "before_start", 0, 0, false, false);

        return true;
    };

    this.hide = function()
    {
        commandsPopup.hidePopup();

        return true;
    };

    this.toggle = function(element)
    {
        this.isShown() ? this.hide() : this.show(element);
    };

    this.removeCommandSelection = function()
    {
        var selected = commandsPopup.ownerDocument.getElementsByClassName("selected")[0];
        Css.removeClass(selected, "selected");
    };

    this.selectCommand = function(element)
    {
        this.removeCommandSelection();

        Css.setClass(element, "selected");
    };

    this.onMouseOver = function(event)
    {
        var hovered = event.target;

        if (hovered.localName == "vbox")
            return;

        Firebug.CommandLine.commandHistory.selectCommand(hovered);
    };

    this.onMouseUp = function(event)
    {
        var commandLine = Firebug.CommandLine.getCommandLine(Firebug.currentContext);

        commandLine.value = commands[event.target.value];
        commandPointer = event.target.value;

        Firebug.CommandLine.commandHistory.hide();
    };

    this.onPopupHidden = function(event)
    {
        Firebug.chrome.setGlobalAttribute("fbCommandLineHistoryButton", "checked", "false");
        Firebug.chrome.setGlobalAttribute("fbCommandEditorHistoryButton", "checked", "false");
    };
};

// ********************************************************************************************* //
// CommandLine Injector

Firebug.CommandLine.injector =
{
    isAttached: function(win)
    {
        var contentView = Wrapper.getContentView(win);
        return contentView._FirebugCommandLine ? true : false;
    },

    attachCommandLine: function(context, win)
    {
        win = win ? win : context.window;
        if (win instanceof win.Window)
        {
            // If the command line is already attached then end.
            if (this.isAttached(win))
                return;

            var contentView = Wrapper.getContentView(win);
            contentView._FirebugCommandLine =
                Firebug.CommandLineExposed.createFirebugCommandLine(context, win);

            this.addCommandLineListener(context, win);
        }
        else if (Firebug.CommandLine.isSandbox(context))
        {
            if (FBTrace.DBG_COMMANDLINE)
                FBTrace.sysout("commandLine.injector context.global "+context.global, context.global);
        }
        else
        {
            if (FBTrace.DBG_COMMANDLINE)
                FBTrace.sysout("commandLine.injector, win: "+win+" not a Window or Sandbox", win);
        }
    },

    detachCommandLine: function(context, win)
    {
        win = win ? win : context.window;
        if (this.isAttached(win))
        {
            function failureCallback(result, context)
            {
                if (FBTrace.DBG_ERRORS)
                    FBTrace.sysout("Firebug.CommandLine.evaluate FAILS  "+result, result);
            }

            //Firebug.CommandLine.evaluate("window._FirebugCommandLine.detachCommandLine()",
            //    context, null, win, null, failureCallback );
            var contentView = Wrapper.getContentView(win);
            contentView._FirebugCommandLine.detachCommandLine();

            this.removeCommandLineListener(context, win);
        }
    },

    // * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * //
    // Listener

    addCommandLineListener: function(context, win)
    {
        // Register listener for command-line execution events.
        var handler = new CommandLineHandler(context, win);
        var boundHandler = Obj.bind(handler.handleEvent, handler);

        if (!context.activeCommandLineHandlers)
            context.activeCommandLineHandlers = {};

        var consoleHandler = Firebug.Console.injector.getConsoleHandler(context, win);
        context.activeCommandLineHandlers[consoleHandler.token] = boundHandler;

        Events.addEventListener(win.document, "firebugExecuteCommand", boundHandler, true);

        if (FBTrace.DBG_COMMANDLINE)
            FBTrace.sysout("commandLine.addCommandLineListener to document in window"+
                win.location+" with console ", win.console);
    },

    removeCommandLineListener: function(context, win)
    {
        var boundHandler = this.getCommandLineListener(context, win);
        if (boundHandler)
            Events.removeEventListener(win.document, "firebugExecuteCommand", boundHandler, true);

        if (FBTrace.DBG_COMMANDLINE)
            FBTrace.sysout("commandLine.detachCommandLineListener "+boundHandler+
                " in window with console "+win.location);
    },

    getCommandLineListener: function(context, win)
    {
        if (context.activeCommandLineHandlers)
        {
            var consoleHandler = Firebug.Console.injector.getConsoleHandler(context, win);
            if (consoleHandler)
                return context.activeCommandLineHandlers[consoleHandler.token];

            if (FBTrace.DBG_CONSOLE)
                FBTrace.sysout("getCommandLineListener no consoleHandler for "+context.getName()+
                    " win "+Win.safeGetWindowLocation(win));
        }
    },
};

// ********************************************************************************************* //
// CommandLine Handler

function CommandLineHandler(context, win)
{
    this.handleEvent = function(event)  // win is the window the handler is bound into
    {
        context.baseWindow = context.baseWindow || context.window;
        this.api = new FirebugCommandLineAPI(context);

        if (FBTrace.DBG_COMMANDLINE)
            FBTrace.sysout("commandLine.handleEvent('firebugExecuteCommand') event in context.baseWindow "+
                context.baseWindow.location, event);

        // Appends variables into the api.
        var htmlPanel = context.getPanel("html", true);
        var vars = htmlPanel ? htmlPanel.getInspectorVars():null;

        for (var prop in vars)
        {
            function createHandler(p) {
                return function() {
                    if (FBTrace.DBG_COMMANDLINE)
                        FBTrace.sysout("commandLine.getInspectorHistory: " + p, vars);
                    return Wrapper.unwrapObject(vars[p]);
                }
            }
            this.api[prop] = createHandler(prop);  // XXXjjb should these be removed?
        }

        if (!Firebug.CommandLine.CommandHandler.handle(event, this.api, win))
        {
            var methodName = win.document.getUserData("firebug-methodName");
            Firebug.Console.log(Locale.$STRF("commandline.MethodNotSupported", [methodName]));
        }

        if (FBTrace.DBG_COMMANDLINE)
            FBTrace.sysout("commandLine.handleEvent() "+win.document.getUserData("firebug-methodName")+
                " context.baseWindow: "+(context.baseWindow?context.baseWindow.location:"no basewindow"),
                context.baseWindow);
    };
}

function getNoScript()
{
    // The wrappedJSObject here is not a security wrapper, it is a property set by the service.
    if (!this.noscript)
        this.noscript = Cc["@maone.net/noscript-service;1"] &&
            Cc["@maone.net/noscript-service;1"].getService().wrappedJSObject;
    return this.noscript;
}

// ************************************************************************************************
// Registration

Firebug.registerModule(Firebug.CommandLine);

return Firebug.CommandLine;

// ************************************************************************************************
});
