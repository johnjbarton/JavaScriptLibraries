/* See license.txt for terms of usage */

define([
    "firebug/lib/object",
    "firebug/firebug",
    "firebug/dom/toggleBranch",
    "firebug/lib/events",
    "firebug/lib/dom",
    "firebug/lib/css",
    "firebug/js/stackFrame",
    "firebug/dom/domPanel",     // Firebug.DOMBasePanel, Firebug.DOMPanel.DirTable
],
function(Obj, Firebug, ToggleBranch, Events, Dom, Css, StackFrame) {

// ********************************************************************************************* //
// Watch Panel

Firebug.WatchPanel = function()
{
}

/**
 * Represents the Watch side panel available in the Script panel.
 */
Firebug.WatchPanel.prototype = Obj.extend(Firebug.DOMBasePanel.prototype,
/** @lends Firebug.WatchPanel */
{
    tag: Firebug.DOMPanel.DirTable.watchTag,

    // * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * //
    // extends Panel

    name: "watches",
    order: 0,
    parentPanel: "script",
    enableA11y: true,
    deriveA11yFrom: "console",

    initialize: function()
    {
        this.onMouseDown = Obj.bind(this.onMouseDown, this);
        this.onMouseOver = Obj.bind(this.onMouseOver, this);
        this.onMouseOut = Obj.bind(this.onMouseOut, this);

        Firebug.DOMBasePanel.prototype.initialize.apply(this, arguments);
    },

    destroy: function(state)
    {
        state.watches = this.watches;

        Firebug.DOMBasePanel.prototype.destroy.apply(this, arguments);
    },

    show: function(state)
    {
        if (state && state.watches)
            this.watches = state.watches;
    },

    initializeNode: function(oldPanelNode)
    {
        this.panelNode.addEventListener("mousedown", this.onMouseDown, false);
        this.panelNode.addEventListener("mouseover", this.onMouseOver, false);
        this.panelNode.addEventListener("mouseout", this.onMouseOut, false);

        Firebug.DOMBasePanel.prototype.initializeNode.apply(this, arguments);
    },

    destroyNode: function()
    {
        this.panelNode.removeEventListener("mousedown", this.onMouseDown, false);
        this.panelNode.removeEventListener("mouseover", this.onMouseOver, false);
        this.panelNode.removeEventListener("mouseout", this.onMouseOut, false);

        Firebug.DOMBasePanel.prototype.destroyNode.apply(this, arguments);
    },

    refresh: function()
    {
        this.rebuild(true);
    },

    updateSelection: function(frame)
    {
        // this method is called while the debugger has halted JS,
        // so failures don't show up in FBS_ERRORS
        try
        {
            this.doUpdateSelection(frame);
        }
        catch (exc)
        {
            if (FBTrace.DBG_ERRORS && FBTrace.DBG_STACK)
                FBTrace.sysout("updateSelection FAILS " + exc, exc);
        }
    },

    doUpdateSelection: function(frame)
    {
        if (FBTrace.DBG_STACK)
            FBTrace.sysout("dom watch panel updateSelection frame " + frame, frame);

        Events.dispatch(this.fbListeners, "onBeforeDomUpdateSelection", [this]);

        var newFrame = frame && ("signature" in frame) &&
            (frame.signature() != this.frameSignature);

        if (newFrame)
        {
            this.toggles = new ToggleBranch.ToggleBranch();
            this.frameSignature = frame.signature();
        }

        if (frame instanceof StackFrame.StackFrame)
            var scopes = frame.getScopes(Firebug.viewChrome);
        else
            var scopes = [this.context.getGlobalScope()];

        if (FBTrace.DBG_STACK)
            FBTrace.sysout("dom watch frame isStackFrame " +
                (frame instanceof StackFrame.StackFrame) +
                " updateSelection scopes " + scopes.length, scopes);

        var members = [];

        if (this.watches)
        {
            for (var i = 0; i < this.watches.length; ++i)
            {
                var expr = this.watches[i];
                var value = null;

                Firebug.CommandLine.evaluate(expr, this.context, null, this.context.getGlobalScope(),
                    function success(result, context)
                    {
                        value = result;
                    },
                    function failed(result, context)
                    {
                        var exc = result;
                        value = new FirebugReps.ErrorCopy(exc+"");
                    }
                );

                this.addMember(scopes[0], "watch", members, expr, value, 0);

                if (FBTrace.DBG_DOM)
                    FBTrace.sysout("watch.updateSelection " + expr + " = " + value,
                        {expr: expr, value: value, members: members})
            }
        }

        if (frame && frame instanceof StackFrame.StackFrame)
        {
            var thisVar = frame.getThisValue();
            if (thisVar)
                this.addMember(scopes[0], "user", members, "this", thisVar, 0);

            // locals, pre-expanded
            members.push.apply(members, this.getMembers(scopes[0], 0, this.context));

            for (var i=1; i<scopes.length; i++)
                this.addMember(scopes[i], "scopes", members, scopes[i].toString(), scopes[i], 0);
        }

        this.expandMembers(members, this.toggles, 0, 0, this.context);
        this.showMembers(members, false);

        if (FBTrace.DBG_STACK)
            FBTrace.sysout("dom watch panel updateSelection members " + members.length, members);
    },

    rebuild: function()
    {
        this.updateSelection(this.selection);
    },

    showEmptyMembers: function()
    {
        this.tag.replace({domPanel: this, toggles: new ToggleBranch.ToggleBranch()},
            this.panelNode);
    },

    addWatch: function(expression)
    {
        if (!this.watches)
            this.watches = [];

        for (var i=0; i<this.watches.length; i++)
        {
            if (expression == this.watches[i])
                return;
        }

        this.watches.splice(0, 0, expression);
        this.rebuild(true);
    },

    removeWatch: function(expression)
    {
        if (!this.watches)
            return;

        var index = this.watches.indexOf(expression);
        if (index != -1)
            this.watches.splice(index, 1);
    },

    editNewWatch: function(value)
    {
        var watchNewRow = this.panelNode.getElementsByClassName("watchNewRow").item(0);
        if (watchNewRow)
            this.editProperty(watchNewRow, value);
    },

    setWatchValue: function(row, value)
    {
        var rowIndex = getWatchRowIndex(row);
        this.watches[rowIndex] = value;
        this.rebuild(true);
    },

    deleteWatch: function(row)
    {
        var rowIndex = getWatchRowIndex(row);
        this.watches.splice(rowIndex, 1);
        this.rebuild(true);

        this.context.setTimeout(Obj.bindFixed(function()
        {
            this.showToolbox(null);
        }, this));
    },

    // * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * //

    showToolbox: function(row)
    {
        var toolbox = this.getToolbox();
        if (row)
        {
            if (Css.hasClass(row, "editing"))
                return;

            toolbox.watchRow = row;

            var offset = Dom.getClientOffset(row);
            toolbox.style.top = offset.y + "px";
            this.panelNode.appendChild(toolbox);
        }
        else
        {
            delete toolbox.watchRow;

            if (toolbox.parentNode)
                toolbox.parentNode.removeChild(toolbox);
        }
    },

    getToolbox: function()
    {
        if (!this.toolbox)
        {
            this.toolbox = Firebug.DOMBasePanel.ToolboxPlate.tag.replace(
                {domPanel: this}, this.document);
        }

        return this.toolbox;
    },

    // * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * //

    onMouseDown: function(event)
    {
        var watchNewRow = Dom.getAncestorByClass(event.target, "watchNewRow");
        if (watchNewRow)
        {
            this.editProperty(watchNewRow);
            Events.cancelEvent(event);
        }
    },

    onMouseOver: function(event)
    {
        var watchRow = Dom.getAncestorByClass(event.target, "watchRow");
        if (watchRow)
            this.showToolbox(watchRow);
    },

    onMouseOut: function(event)
    {
        if (Dom.isAncestor(event.relatedTarget, this.getToolbox()))
            return;

        var watchRow = Dom.getAncestorByClass(event.relatedTarget, "watchRow");
        if (!watchRow)
            this.showToolbox(null);
    },
});

// ********************************************************************************************* //
// Local Helpers

function getWatchRowIndex(row)
{
    var index = -1;
    for (; row && Css.hasClass(row, "watchRow"); row = row.previousSibling)
        ++index;
    return index;
}

// ********************************************************************************************* //
// Registration

Firebug.registerPanel(Firebug.WatchPanel);

return Firebug.WatchPanel;

// ********************************************************************************************* //
});
