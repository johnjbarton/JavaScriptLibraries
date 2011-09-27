/* See license.txt for terms of usage */

define([
    "firebug/lib/object",
    "firebug/firebug",
    "firebug/firefox/firefox",
    "firebug/lib/domplate",
    "firebug/chrome/reps",
    "firebug/firefox/xpcom",
    "firebug/lib/locale",
    "firebug/lib/events",
    "firebug/lib/wrapper",
    "firebug/lib/url",
    "firebug/js/sourceLink",
    "firebug/lib/css",
    "firebug/lib/dom",
    "firebug/firefox/window",
    "firebug/lib/search",
    "firebug/lib/xpath",
    "firebug/lib/string",
    "firebug/lib/xml",
    "firebug/lib/array",
    "firebug/lib/persist",
    "firebug/firefox/system",
    "firebug/editor/editor",
    "firebug/editor/editorSelector",
    "firebug/chrome/infotip",
    "firebug/chrome/searchBox",
],
function(Obj, Firebug, Firefox, Domplate, FirebugReps, Xpcom, Locale, Events, Wrapper, Url,
    SourceLink, Css, Dom, Win, Search, Xpath, Str, Xml, Arr, Persist, System) {

with (Domplate) {

// ********************************************************************************************* //
// Constants

const Cc = Components.classes;
const Ci = Components.interfaces;
const nsIURI = Ci.nsIURI;
const nsIDOMCSSStyleRule = Ci.nsIDOMCSSStyleRule;
const nsIInterfaceRequestor = Ci.nsIInterfaceRequestor;
const nsISelectionDisplay = Ci.nsISelectionDisplay;
const nsISelectionController = Ci.nsISelectionController;

// before firefox 6 getCSSStyleRules accepted only one argument
const DOMUTILS_SUPPORTS_PSEUDOELEMENTS = Dom.domUtils.getCSSStyleRules.length > 1;

// See: http://mxr.mozilla.org/mozilla1.9.2/source/content/events/public/nsIEventStateManager.h#153
const STATE_ACTIVE  = 0x01;
const STATE_FOCUS   = 0x02;
const STATE_HOVER   = 0x04;

// * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * //

var CSSDomplateBase =
{
    isEditable: function(rule)
    {
        return !rule.isSystemSheet && !rule.isNotEditable;
    },

    isSelectorEditable: function(rule)
    {
        return rule.isSelectorEditable && this.isEditable(rule);
    }
};

var CSSPropTag = domplate(CSSDomplateBase,
{
    tag:
        DIV({"class": "cssProp focusRow", $disabledStyle: "$prop.disabled",
            $editGroup: "$rule|isEditable",
            $cssOverridden: "$prop.overridden",
            role: "option"},
            SPAN("&nbsp;&nbsp;&nbsp;&nbsp;"), // Use spaces for indent so, copy to clipboard is nice.
            SPAN({"class": "cssPropName", $editable: "$rule|isEditable"},
                "$prop.name"
            ),
            SPAN({"class": "cssColon"}, ":&nbsp;"), // Use space here so, copy to clipboard has it (3266).
            SPAN({"class": "cssPropValue", $editable: "$rule|isEditable"},
                "$prop.value$prop.important"
            ),
            SPAN({"class": "cssSemi"}, ";"
        )
    )
});

var CSSRuleTag =
    TAG("$rule.tag", {rule: "$rule"});

var CSSImportRuleTag = domplate(
{
    tag:
        DIV({"class": "cssRule insertInto focusRow importRule", _repObject: "$rule.rule"},
        "@import &quot;",
        A({"class": "objectLink", _repObject: "$rule.rule.styleSheet"}, "$rule.rule.href"),
        "&quot;;"
    )
});

var CSSFontFaceRuleTag = domplate(CSSDomplateBase,
{
    tag:
        DIV({"class": "cssRule cssFontFaceRule",
            $cssEditableRule: "$rule|isEditable",
            $insertInto: "$rule|isEditable",
            _repObject: "$rule.rule",
            role : 'presentation'},
            DIV({"class": "cssHead focusRow", role : "listitem"}, "@font-face {"),
            DIV({role : "group"},
                DIV({"class": "cssPropertyListBox", role: "listbox"},
                    FOR("prop", "$rule.props",
                        TAG(CSSPropTag.tag, {rule: "$rule", prop: "$prop"})
                    )
                )
            ),
            DIV({$editable: "$rule|isEditable", $insertBefore:"$rule|isEditable",
                role:"presentation"},
                "}"
            )
        )
});

var CSSStyleRuleTag = domplate(CSSDomplateBase,
{
    tag:
        DIV({"class": "cssRule",
            $cssEditableRule: "$rule|isEditable",
            $insertInto: "$rule|isEditable",
            $editGroup: "$rule|isSelectorEditable",
            _repObject: "$rule.rule",
            "ruleId": "$rule.id", role: "presentation"},
            DIV({"class": "cssHead focusRow", role: "listitem"},
                SPAN({"class": "cssSelector", $editable: "$rule|isSelectorEditable"},
                    "$rule.selector"),
                    " {"
                ),
            DIV({role: "group"},
                DIV({"class": "cssPropertyListBox", _rule: "$rule", role: "listbox"},
                    FOR("prop", "$rule.props",
                        TAG(CSSPropTag.tag, {rule: "$rule", prop: "$prop"})
                    )
                )
            ),
            DIV({$editable: "$rule|isEditable", $insertBefore: "$rule|isEditable",
                role:"presentation"},
                "}"
            )
        )
});

// ********************************************************************************************* //

const reSplitCSS =  /(url\("?[^"\)]+?"?\))|(rgba?\(.*?\))|(hsla?\(.*?\))|(#[\dA-Fa-f]+)|(-?\d+(\.\d+)?(%|[a-z]{1,4})?)|([^,\s\/!\(\)]+)|"(.*?)"|(!(.*)?)/;
const reURL = /url\("?([^"\)]+)?"?\)/;
const reRepeat = /no-repeat|repeat-x|repeat-y|repeat/;

const styleGroups =
{
    text: [
        "font-family",
        "font-size",
        "font-weight",
        "font-style",
        "font-size-adjust",
        "color",
        "text-transform",
        "text-decoration",
        "letter-spacing",
        "word-spacing",
        "line-height",
        "text-align",
        "vertical-align",
        "direction",
        "column-count",
        "column-gap",
        "column-width",
        "-moz-tab-size", // FF4.0
        "-moz-font-feature-settings", // FF4.0
        "-moz-font-language-override" // FF4.0
    ],

    background: [
        "background-color",
        "background-image",
        "background-repeat",
        "background-position",
        "background-attachment",
        "opacity",
        "-moz-background-clip",
        "-moz-background-inline-policy",
        "-moz-background-origin",
        "-moz-background-size",
        "-moz-image-region"
    ],

    box: [
        "width",
        "height",
        "top",
        "right",
        "bottom",
        "left",
        "margin-top",
        "margin-right",
        "margin-bottom",
        "margin-left",
        "padding-top",
        "padding-right",
        "padding-bottom",
        "padding-left",
        "-moz-padding-start",
        "-moz-padding-end",
        "border-top-width",
        "border-right-width",
        "border-bottom-width",
        "border-left-width",
        "border-top-color",
        "-moz-border-top-colors",
        "border-right-color",
        "-moz-border-right-colors",
        "border-bottom-color",
        "-moz-border-bottom-colors",
        "border-left-color",
        "-moz-border-left-colors",
        "border-top-style",
        "border-right-style",
        "border-bottom-style",
        "border-left-style",
        "-moz-border-end",
        "-moz-border-end-color",
        "-moz-border-end-style",
        "-moz-border-end-width",
        "-moz-border-image",
        "-moz-border-start",
        "-moz-border-start-color",
        "-moz-border-start-style",
        "-moz-border-start-width",
        "-moz-border-top-radius",
        "-moz-border-right-radius",
        "-moz-border-bottom-radius",
        "-moz-border-left-radius",
        "-moz-outline-radius-bottomleft",
        "-moz-outline-radius-bottomright",
        "-moz-outline-radius-topleft",
        "-moz-outline-radius-topright",
        "-moz-box-shadow",
        "box-shadow",
        "outline-top-width",
        "outline-right-width",
        "outline-bottom-width",
        "outline-left-width",
        "outline-top-color",
        "outline-right-color",
        "outline-bottom-color",
        "outline-left-color",
        "outline-top-style",
        "outline-right-style",
        "outline-bottom-style",
        "outline-left-style",
        "-moz-box-align",
        "-moz-box-direction",
        "-moz-box-flex",
        "-moz-box-flexgroup",
        "-moz-box-ordinal-group",
        "-moz-box-orient",
        "-moz-box-pack",
        "-moz-box-sizing",
        "-moz-margin-start",
        "-moz-margin-end"
    ],

    layout: [
        "position",
        "display",
        "visibility",
        "z-index",
        "overflow-x",  // http://www.w3.org/TR/2002/WD-css3-box-20021024/#overflow
        "overflow-y",
        "overflow-clip",
        "-moz-transform",
        "-moz-transform-origin",
        "white-space",
        "clip",
        "float",
        "clear",
        "-moz-appearance",
        "-moz-stack-sizing",
        "-moz-column-count",
        "-moz-column-gap",
        "-moz-column-width",
        "-moz-column-rule",
        "-moz-column-rule-width",
        "-moz-column-rule-style",
        "-moz-column-rule-color",
        "-moz-float-edge"
    ],

    other: [
        "cursor",
        "list-style-image",
        "list-style-position",
        "list-style-type",
        "marker-offset",
        "-moz-user-focus",
        "-moz-user-select",
        "-moz-user-modify",
        "-moz-user-input",
        "-moz-animation", // FF5.0
        "-moz-animation-delay", // FF5.0
        "-moz-animation-direction", // FF5.0
        "-moz-animation-duration", // FF5.0
        "-moz-animation-iteration-count", // FF5.0
        "-moz-animation-name", // FF5.0
        "-moz-animation-play-state", // FF5.0
        "-moz-animation-timing-function", // FF5.0
        "-moz-animation-fill-mode", // FF5.0
        "-moz-transition", // FF4.0
        "-moz-transition-delay", // FF4.0
        "-moz-transition-duration", // FF4.0
        "-moz-transition-property", // FF4.0
        "-moz-transition-timing-function", // FF4.0
        "-moz-force-broken-image-icon",
        "-moz-window-shadow"
    ]
};

// ********************************************************************************************* //
// CSS Module

Firebug.CSSModule = Obj.extend(Obj.extend(Firebug.Module, Firebug.EditorSelector),
{
    dispatchName: "cssModule",

    freeEdit: function(styleSheet, value)
    {
        if (!styleSheet.editStyleSheet)
        {
            var ownerNode = getStyleSheetOwnerNode(styleSheet);
            styleSheet.disabled = true;

            var url = Xpcom.CCSV("@mozilla.org/network/standard-url;1", Components.interfaces.nsIURL);
            url.spec = styleSheet.href;

            var editStyleSheet = ownerNode.ownerDocument.createElementNS(
                "http://www.w3.org/1999/xhtml",
                "style");

            Firebug.setIgnored(editStyleSheet);
            editStyleSheet.setAttribute("type", "text/css");
            editStyleSheet.setAttributeNS(
                "http://www.w3.org/XML/1998/namespace",
                "base",
                url.directory);

            if (ownerNode.hasAttribute("media"))
            {
                editStyleSheet.setAttribute("media", ownerNode.getAttribute("media"));
            }

            // Insert the edited stylesheet directly after the old one to ensure the styles
            // cascade properly.
            ownerNode.parentNode.insertBefore(editStyleSheet, ownerNode.nextSibling);

            styleSheet.editStyleSheet = editStyleSheet;
        }

        styleSheet.editStyleSheet.innerHTML = value;

        if (FBTrace.DBG_CSS)
            FBTrace.sysout("css.saveEdit styleSheet.href:" + styleSheet.href +
                " got innerHTML:" + value);

        Events.dispatch(this.fbListeners, "onCSSFreeEdit", [styleSheet, value]);
    },

    insertRule: function(styleSheet, cssText, ruleIndex)
    {
        if (FBTrace.DBG_CSS) FBTrace.sysout("Insert: " + ruleIndex + " " + cssText);
        var insertIndex = styleSheet.insertRule(cssText, ruleIndex);

        Events.dispatch(this.fbListeners, "onCSSInsertRule", [styleSheet, cssText, ruleIndex]);

        return insertIndex;
    },

    deleteRule: function(styleSheet, ruleIndex)
    {
        if (FBTrace.DBG_CSS)
            FBTrace.sysout("deleteRule: " + ruleIndex + " " + styleSheet.cssRules.length,
                styleSheet.cssRules);

        Events.dispatch(this.fbListeners, "onCSSDeleteRule", [styleSheet, ruleIndex]);

        styleSheet.deleteRule(ruleIndex);
    },

    setProperty: function(rule, propName, propValue, propPriority)
    {
        var style = rule.style || rule;

        // Record the original CSS text for the inline case so we can reconstruct at a later
        // point for diffing purposes
        var baseText = style.cssText;

        var prevValue = style.getPropertyValue(propName);
        var prevPriority = style.getPropertyPriority(propName);

        // XXXjoe Gecko bug workaround: Just changing priority doesn't have any effect
        // unless we remove the property first
        style.removeProperty(propName);

        style.setProperty(propName, propValue, propPriority);

        if (propName) {
            Events.dispatch(this.fbListeners, "onCSSSetProperty", [style, propName, propValue,
                propPriority, prevValue, prevPriority, rule, baseText]);
        }
    },

    removeProperty: function(rule, propName, parent)
    {
        var style = rule.style || rule;

        // Record the original CSS text for the inline case so we can reconstruct at a later
        // point for diffing purposes
        var baseText = style.cssText;

        var prevValue = style.getPropertyValue(propName);
        var prevPriority = style.getPropertyPriority(propName);

        style.removeProperty(propName);

        if (propName)
            Events.dispatch(this.fbListeners, "onCSSRemoveProperty", [style, propName, prevValue,
                prevPriority, rule, baseText]);
    },

    /**
     * Method for atomic propertly removal, such as through the context menu.
     */
    deleteProperty: function(rule, propName, context)
    {
        Events.dispatch(this.fbListeners, "onBeginFirebugChange", [rule, context]);
        Firebug.CSSModule.removeProperty(rule, propName);
        Events.dispatch(this.fbListeners, "onEndFirebugChange", [rule, context]);
    },

    disableProperty: function(disable, rule, propName, parsedValue, map, context)
    {
        Events.dispatch(this.fbListeners, "onBeginFirebugChange", [rule, context]);

        if (disable)
        {
            Firebug.CSSModule.removeProperty(rule, propName);

            map.push({"name": propName, "value": parsedValue.value,
                "important": parsedValue.priority});
        }
        else
        {
            Firebug.CSSModule.setProperty(rule, propName, parsedValue.value, parsedValue.priority);

            var index = findPropByName(map, propName);
            map.splice(index, 1);
        }

        Events.dispatch(this.fbListeners, "onEndFirebugChange", [rule, context]);
    },

    cleanupSheets: function(doc, context)
    {
        if (!context)
            return;

        // Due to the manner in which the layout engine handles multiple
        // references to the same sheet we need to kick it a little bit.
        // The injecting a simple stylesheet then removing it will force
        // Firefox to regenerate it's CSS hierarchy.
        //
        // WARN: This behavior was determined anecdotally.
        // See http://code.google.com/p/fbug/issues/detail?id=2440

        // This causes additional HTTP request for a font (see 4649).
        /*if (!Xml.isXMLPrettyPrint(context))
        {
            var style = Css.createStyleSheet(doc);
            style.innerHTML = "#fbIgnoreStyleDO_NOT_USE {}";
            Css.addStyleSheet(doc, style);

            if (style.parentNode)
            {
                style.parentNode.removeChild(style);
            }
            else
            {
                if (FBTrace.DBG_ERRORS)
                    FBTrace.sysout("css.cleanupSheets; ERROR no parent style:", style);
            }
        }*/

        // https://bugzilla.mozilla.org/show_bug.cgi?id=500365
        // This voodoo touches each style sheet to force some Firefox internal change
        // to allow edits.
        var styleSheets = Css.getAllStyleSheets(context);
        for(var i = 0; i < styleSheets.length; i++)
        {
            try
            {
                var rules = styleSheets[i].cssRules;
                if (rules.length > 0)
                    var touch = rules[0];

                //if (FBTrace.DBG_CSS && touch)
                //    FBTrace.sysout("css.show() touch "+typeof(touch)+" in "+
                //        (styleSheets[i].href?styleSheets[i].href:context.getName()));
            }
            catch(e)
            {
                if (FBTrace.DBG_ERRORS)
                    FBTrace.sysout("css.show: sheet.cssRules FAILS for "+
                        (styleSheets[i]?styleSheets[i].href:"null sheet")+e, e);
            }
        }
    },

    cleanupSheetHandler: function(event, context)
    {
        var target = event.target,
            tagName = (target.tagName || "").toLowerCase();
        if (tagName == "link")
        {
            this.cleanupSheets(target.ownerDocument, context);
        }
    },

    // * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * //
    // Module functions

    initialize: function()
    {
        this.editors = {};
        this.registerEditor("Live",
        {
            startEditing: function(stylesheet, context, panel)
            {
                panel.startLiveEditing(stylesheet, context);
            },
            stopEditing: function()
            {
                Firebug.Editor.stopEditing();
            }
        });

        this.registerEditor("Source",
        {
            startEditing: function(stylesheet, context, panel)
            {
                panel.startSourceEditing(stylesheet, context);
            },
            stopEditing: function()
            {
                Firebug.Editor.stopEditing();
            }
        });
    },

    watchWindow: function(context, win)
    {
        var cleanupSheets = Obj.bind(this.cleanupSheets, this),
            cleanupSheetHandler = Obj.bind(this.cleanupSheetHandler, this, context),
            doc = win.document;

        Events.addEventListener(doc, "DOMAttrModified", cleanupSheetHandler, false);
        Events.addEventListener(doc, "DOMNodeInserted", cleanupSheetHandler, false);
    },

    loadedContext: function(context)
    {
        var self = this;
        Win.iterateWindows(context.browser.contentWindow, function(subwin)
        {
            self.cleanupSheets(subwin.document, context);
        });
    },

    initContext: function(context)
    {
        context.dirtyListener = new Firebug.CSSDirtyListener(context);
        this.addListener(context.dirtyListener);
    },

    destroyContext: function(context)
    {
        this.removeListener(context.dirtyListener);
    },
});

// ********************************************************************************************* //

Firebug.CSSStyleSheetPanel = function() {};

Firebug.CSSStyleSheetPanel.prototype = Obj.extend(Firebug.Panel,
{
    template: domplate(
    {
        tag:
            DIV({"class": "cssSheet insertInto a11yCSSView"},
                FOR("rule", "$rules",
                    CSSRuleTag
                ),
                DIV({"class": "cssSheet editable insertBefore"}, "")
                )
    }),

    // * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * //

    refresh: function()
    {
        if (this.location)
            this.updateLocation(this.location);
        else if (this.selection)
            this.updateSelection(this.selection);
    },

    // * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * //
    // CSS Editing

    startBuiltInEditing: function(css)
    {
        if (!this.stylesheetEditor)
            this.stylesheetEditor = new StyleSheetEditor(this.document);

        var styleSheet = this.location.editStyleSheet
            ? this.location.editStyleSheet.sheet
            : this.location;

        this.stylesheetEditor.styleSheet = this.location;
        Firebug.Editor.startEditing(this.panelNode, css, this.stylesheetEditor);

        //this.stylesheetEditor.scrollToLine(topmost.line, topmost.offset);
        this.stylesheetEditor.input.scrollTop = this.panelNode.scrollTop;
    },

    startLiveEditing: function(styleSheet, context)
    {
        var css = getStyleSheetCSS(styleSheet, context);
        this.startBuiltInEditing(css);
    },

    startSourceEditing: function(styleSheet, context)
    {
        if (Firebug.CSSDirtyListener.isDirty(styleSheet, context))
        {
            var prompts = Cc["@mozilla.org/embedcomp/prompt-service;1"].
                getService(Ci.nsIPromptService);

            var proceedToEdit = prompts.confirm(null, Locale.$STR("Firebug"),
                Locale.$STR("confirmation.Edit_CSS_Source"));

            if (!proceedToEdit)
            {
                this.stopEditing();
                return;
            }
        }

        var css = getOriginalStyleSheetCSS(styleSheet, context);
        this.startBuiltInEditing(css);
    },

    stopEditing: function()
    {
        if (this.currentCSSEditor)
        {
            this.currentCSSEditor.stopEditing();
            delete this.currentCSSEditor;
        }
        else
        {
            Firebug.Editor.stopEditing();
        }
    },

    toggleEditing: function()
    {
        if (this.editing)
        {
            this.stopEditing();
            Events.dispatch(this.fbListeners, 'onStopCSSEditing', [this.context]);
        }
        else
        {
            if (!this.location)
                return;

            var styleSheet = this.location.editStyleSheet
                ? this.location.editStyleSheet.sheet
                : this.location;

            this.currentCSSEditor = Firebug.CSSModule.getCurrentEditor();
            try
            {
                this.currentCSSEditor.startEditing(styleSheet, this.context, this);
                Events.dispatch(this.fbListeners, 'onStartCSSEditing', [styleSheet, this.context]);
            }
            catch(exc)
            {
                var mode = Firebug.CSSModule.getCurrentEditorName();
                if (FBTrace.DBG_ERRORS)
                    FBTrace.sysout("editor.startEditing ERROR "+exc, {exc: exc, name: mode,
                        currentEditor: this.currentCSSEditor, styleSheet: styleSheet,
                        CSSModule:Firebug.CSSModule});
            }
        }
    },

    // * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * //

    loadOriginalSource: function()
    {
        if (!this.location)
            return;

        var styleSheet = this.location;

        var css = getOriginalStyleSheetCSS(styleSheet, this.context);

        this.stylesheetEditor.setValue(css);
        this.stylesheetEditor.saveEdit(null, css);
        //styleSheet.editStyleSheet.showUnformated = true;
    },

    getStylesheetURL: function(rule, getBaseUri)
    {
        if (this.location.href)
            return this.location.href;
        else if (getBaseUri)
            return this.context.window.document.baseURI;
        else
            return this.context.window.location.href;
    },

    getRuleByLine: function(styleSheet, line)
    {
        if (!Dom.domUtils)
            return null;

        var cssRules = styleSheet.cssRules;
        for (var i = 0; i < cssRules.length; ++i)
        {
            var rule = cssRules[i];
            var previousRule;
            if (rule instanceof window.CSSStyleRule)
            {
                var selectorLine = Dom.domUtils.getRuleLine(rule);
                // The declarations are on lines equal or greater than the selectorLine
                if (selectorLine === line) // then the line requested is a selector line
                    return rule;
                if (selectorLine > line) // then we passed the rule for the requested line
                    return previousRule;
                // else the requested line is still ahead
                previousRule = rule;
            }
        }
    },

    highlightRule: function(rule)
    {
        var ruleElement = Firebug.getElementByRepObject(this.panelNode.firstChild, rule);
        if (ruleElement)
        {
            Dom.scrollIntoCenterView(ruleElement, this.panelNode);
            Css.setClassTimed(ruleElement, "jumpHighlight", this.context);
        }
    },

    getStyleSheetRules: function(context, styleSheet)
    {
        if (!styleSheet)
            return [];

        var isSystemSheet = Url.isSystemStyleSheet(styleSheet);

        function appendRules(cssRules)
        {
            var i, props, ruleId;

            if (!cssRules)
                return;

            for (i=0; i<cssRules.length; ++i)
            {
                var rule = cssRules[i];
                if (rule instanceof window.CSSStyleRule)
                {
                    props = this.getRuleProperties(context, rule);
                    ruleId = getRuleId(rule);
                    rules.push({
                        tag: CSSStyleRuleTag.tag,
                        rule: rule,
                        id: ruleId,
                        // Show universal selectors with pseudo-class
                        // (http://code.google.com/p/fbug/issues/detail?id=3683)
                        selector: rule.selectorText.replace(/ :/g, " *:"),
                        props: props,
                        isSystemSheet: isSystemSheet,
                        isSelectorEditable: true
                    });
                }
                else if (rule instanceof window.CSSImportRule)
                {
                    rules.push({tag: CSSImportRuleTag.tag, rule: rule});
                }
                else if (rule instanceof window.CSSMediaRule)
                {
                    appendRules.apply(this, [Css.safeGetCSSRules(rule)]);
                }
                else if (rule instanceof window.CSSFontFaceRule)
                {
                    props = this.parseCSSProps(rule.style);
                    sortProperties(props);
                    rules.push({
                        tag: CSSFontFaceRuleTag.tag, rule: rule,
                        props: props, isSystemSheet: isSystemSheet,
                        isNotEditable: true
                    });
                }
                else
                {
                    if (FBTrace.DBG_ERRORS && FBTrace.DBG_CSS)
                        FBTrace.sysout("css getStyleSheetRules failed to classify a rule ", rule);
                }
            }
        }

        var rules = [];
        appendRules.apply(this, [Css.safeGetCSSRules(styleSheet)]);
        return rules;
    },

    parseCSSProps: function(style, inheritMode)
    {
        var m,
            props = [];

        if (Firebug.expandShorthandProps)
        {
            var count = style.length-1,
                index = style.length;
            while (index--)
            {
                var propName = style.item(count - index);
                this.addProperty(propName, style.getPropertyValue(propName),
                    !!style.getPropertyPriority(propName), false, inheritMode, props);
            }
        }
        else
        {
            var lines = style.cssText.match(/(?:[^;\(]*(?:\([^\)]*?\))?[^;\(]*)*;?/g);
            var propRE = /\s*([^:\s]*)\s*:\s*(.*?)\s*(! important)?;?$/;
            var line,i=0;
            while(line=lines[i++]) {
                m = propRE.exec(line);
                if(!m)
                    continue;
                //var name = m[1], value = m[2], important = !!m[3];
                if (m[2])
                    this.addProperty(m[1], m[2], !!m[3], false, inheritMode, props);
            }
        }

        return props;
    },

    getRuleProperties: function(context, rule, inheritMode)
    {
        var props = this.parseCSSProps(rule.style, inheritMode);

        var ruleId = getRuleId(rule);
        this.addOldProperties(context, ruleId, inheritMode, props);
        sortProperties(props);

        return props;
    },

    addOldProperties: function(context, ruleId, inheritMode, props)
    {
        if (context.selectorMap && context.selectorMap.hasOwnProperty(ruleId) )
        {
            var moreProps = context.selectorMap[ruleId];
            for (var i = 0; i < moreProps.length; ++i)
            {
                var prop = moreProps[i];
                this.addProperty(prop.name, prop.value, prop.important, true, inheritMode, props);
            }
        }
    },

    addProperty: function(name, value, important, disabled, inheritMode, props)
    {
        if (inheritMode && !Css.inheritedStyleNames[name])
            return;

        name = this.translateName(name, value);
        if (name)
        {
            value = stripUnits(rgbToHex(value));
            important = important ? " !important" : "";

            var prop = {name: name, value: value, important: important, disabled: disabled};
            props.push(prop);
        }
    },

    translateName: function(name, value)
    {
        // Don't show these proprietary Mozilla properties
        if ((value == "-moz-initial"
            && (name == "-moz-background-clip" || name == "-moz-background-origin"
                || name == "-moz-background-inline-policy"))
        || (value == "physical"
            && (name == "margin-left-ltr-source" || name == "margin-left-rtl-source"
                || name == "margin-right-ltr-source" || name == "margin-right-rtl-source"))
        || (value == "physical"
            && (name == "padding-left-ltr-source" || name == "padding-left-rtl-source"
                || name == "padding-right-ltr-source" || name == "padding-right-rtl-source")))
            return null;

        // Translate these back to the form the user probably expects
        if (name == "margin-left-value")
            return "margin-left";
        else if (name == "margin-right-value")
            return "margin-right";
        else if (name == "margin-top-value")
            return "margin-top";
        else if (name == "margin-bottom-value")
            return "margin-bottom";
        else if (name == "padding-left-value")
            return "padding-left";
        else if (name == "padding-right-value")
            return "padding-right";
        else if (name == "padding-top-value")
            return "padding-top";
        else if (name == "padding-bottom-value")
            return "padding-bottom";
        // XXXjoe What about border!
        else
            return name;
    },

    // * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * //

    editElementStyle: function()
    {
        var rulesBox = this.panelNode.getElementsByClassName("cssElementRuleContainer")[0];
        var styleRuleBox = rulesBox && Firebug.getElementByRepObject(rulesBox, this.selection);
        if (!styleRuleBox)
        {
            var rule = {rule: this.selection, inherited: false, selector: "element.style", props: []};
            if (!rulesBox)
            {
                // The element did not have any displayed styles. We need to create the whole tree and remove
                // the no styles message
                styleRuleBox = this.template.cascadedTag.replace({
                    rules: [rule], inherited: [], inheritLabel: Locale.$STR("InheritedFrom")
                }, this.panelNode);

                styleRuleBox = styleRuleBox.getElementsByClassName("cssElementRuleContainer")[0];
            }
            else
                styleRuleBox = this.template.ruleTag.insertBefore({rule: rule}, rulesBox);

            styleRuleBox = styleRuleBox.getElementsByClassName("insertInto")[0];
        }

        Firebug.Editor.insertRowForObject(styleRuleBox);
    },

    insertPropertyRow: function(row)
    {
        Firebug.Editor.insertRowForObject(row);
    },

    insertRule: function(row)
    {
        var location = Dom.getAncestorByClass(row, "cssRule");
        if (!location)
        {
            location = Dom.getChildByClass(this.panelNode, "cssSheet");

            // Stylesheet has no rules
            if (!location)
                this.template.tag.replace({rules: []}, this.panelNode);

            location = Dom.getChildByClass(this.panelNode, "cssSheet");
            Firebug.Editor.insertRowForObject(location);
        }
        else
        {
            Firebug.Editor.insertRow(location, "before");
        }
    },

    editPropertyRow: function(row)
    {
        var propValueBox = Dom.getChildByClass(row, "cssPropValue");
        Firebug.Editor.startEditing(propValueBox);
    },

    deletePropertyRow: function(row)
    {
        var rule = Firebug.getRepObject(row);
        var propName = Dom.getChildByClass(row, "cssPropName").textContent;
        Firebug.CSSModule.deleteProperty(rule, propName, this.context);

        // Remove the property from the selector map, if it was disabled
        var ruleId = Firebug.getRepNode(row).getAttribute("ruleId");
        if ( this.context.selectorMap && this.context.selectorMap.hasOwnProperty(ruleId) )
        {
            var map = this.context.selectorMap[ruleId];
            for (var i = 0; i < map.length; ++i)
            {
                if (map[i].name == propName)
                {
                    map.splice(i, 1);
                    break;
                }
            }
        }
        if (this.name == "stylesheet")
            Events.dispatch(this.fbListeners, 'onInlineEditorClose', [this, row.firstChild, true]);
        row.parentNode.removeChild(row);

        this.markChange(this.name == "stylesheet");
    },

    disablePropertyRow: function(row)
    {
        Css.toggleClass(row, "disabledStyle");

        var rule = Firebug.getRepObject(row);
        var propName = Dom.getChildByClass(row, "cssPropName").textContent;

        if (!this.context.selectorMap)
            this.context.selectorMap = {};

        // XXXjoe Generate unique key for elements too
        var ruleId = Firebug.getRepNode(row).getAttribute("ruleId");
        if (!(this.context.selectorMap.hasOwnProperty(ruleId)))
            this.context.selectorMap[ruleId] = [];

        var map = this.context.selectorMap[ruleId];
        var propValue = Dom.getChildByClass(row, "cssPropValue").textContent;
        var parsedValue = parsePriority(propValue);

        Firebug.CSSModule.disableProperty(Css.hasClass(row, "disabledStyle"), rule,
            propName, parsedValue, map, this.context);

        this.markChange(this.name == "stylesheet");
    },

    // * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * //

    onMouseDown: function(event)
    {
    },

    onClick: function(event)
    {
        var row;

        if (!Events.isLeftClick(event))
            return;
        // XXjoe Hack to only allow clicking on the checkbox
        if ( (event.clientX <= 20) && (event.detail == 1) )
        {
            if (Css.hasClass(event.target, "textEditor inlineExpander"))
                return;
            row = Dom.getAncestorByClass(event.target, "cssProp");
            if (row && Css.hasClass(row, "editGroup"))
            {
                this.disablePropertyRow(row);
                Events.cancelEvent(event);
            }
        }
        else if( (event.clientX >= 20) && (event.detail == 2) )
        {
            row = Dom.getAncestorByClass(event.target, "cssRule");
            if (row && !Dom.getAncestorByClass(event.target, "cssPropName")
                && !Dom.getAncestorByClass(event.target, "cssPropValue"))
            {
                this.insertPropertyRow(row);
                Events.cancelEvent(event);
            }
        }
    },

    // * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * //
    // extends Panel

    name: "stylesheet",
    parentPanel: null,
    searchable: true,
    dependents: ["css", "stylesheet", "dom", "domSide", "layout"],
    enableA11y: true,
    deriveA11yFrom: "css",
    order: 30,

    initialize: function()
    {
        this.onMouseDown = Obj.bind(this.onMouseDown, this);
        this.onClick = Obj.bind(this.onClick, this);

        Firebug.Panel.initialize.apply(this, arguments);
    },

    destroy: function(state)
    {
        state.scrollTop = this.panelNode.scrollTop ? this.panelNode.scrollTop : this.lastScrollTop;

        Persist.persistObjects(this, state);

        this.stopEditing();

        Firebug.Panel.destroy.apply(this, arguments);
    },

    initializeNode: function(oldPanelNode)
    {
        this.panelNode.addEventListener("mousedown", this.onMouseDown, false);
        this.panelNode.addEventListener("click", this.onClick, false);

        Firebug.Panel.initializeNode.apply(this, arguments);
    },

    destroyNode: function()
    {
        this.panelNode.removeEventListener("mousedown", this.onMouseDown, false);
        this.panelNode.removeEventListener("click", this.onClick, false);

        Firebug.Panel.destroyNode.apply(this, arguments);
    },

    show: function(state)
    {
        Firebug.Inspector.stopInspecting(true);

        this.showToolbarButtons("fbCSSButtons", true);

        Firebug.CSSModule.updateEditButton();

        if (this.context.loaded && !this.location) // wait for loadedContext to restore the panel
        {
            Persist.restoreObjects(this, state);

            if (!this.location)
                this.location = this.getDefaultLocation();

            if (state && state.scrollTop)
                this.panelNode.scrollTop = state.scrollTop;
        }
    },

    hide: function()
    {
        this.lastScrollTop = this.panelNode.scrollTop;
    },

    supportsObject: function(object, type)
    {
        if (object instanceof window.CSSStyleSheet)
            return 1;
        else if (object instanceof window.CSSStyleRule)
            return 2;
        else if (object instanceof window.CSSStyleDeclaration)
            return 2;
        else if (object instanceof SourceLink.SourceLink && object.type == "css" &&
            Url.reCSS.test(object.href))
            return 2;
        else
            return 0;
    },

    updateLocation: function(styleSheet)
    {
        if (FBTrace.DBG_CSS)
            FBTrace.sysout("css.updateLocation; " + (styleSheet ? styleSheet.href : "no stylesheet"));

        var rules = [];
        if (styleSheet)
        {
            // Skip ignored stylesheets, but don't skip the
            // default stylesheet that is used in case there is no other stylesheet
            // on the page.
            var shouldIgnore = Firebug.shouldIgnore(styleSheet.ownerNode);
            var contentView = Wrapper.getContentView(styleSheet);
            var isDefault = contentView && contentView.defaultStylesheet;
            if (!shouldIgnore || isDefault)
            {
                if (styleSheet.editStyleSheet)
                    styleSheet = styleSheet.editStyleSheet.sheet;
                var rules = this.getStyleSheetRules(this.context, styleSheet);
            }
        }

        if (rules.length)
        {
            this.template.tag.replace({rules: rules}, this.panelNode);
        }
        else
        {
            // If there are no rules on the page display a description that also
            // contains a link "create a rule".
            var warning = FirebugReps.Warning.tag.replace({object: ""}, this.panelNode);
            FirebugReps.Description.render(Locale.$STR("css.EmptyStyleSheet"),
                warning, Obj.bind(this.insertRule, this));
        }

        this.showToolbarButtons("fbCSSButtons", !Url.isSystemStyleSheet(this.location));

        Events.dispatch(this.fbListeners, "onCSSRulesAdded", [this, this.panelNode]);

        // If the full editing mode (not the inline) is on while the location changes,
        // open the editor again for another file.
        if (this.editing && this.stylesheetEditor && this.stylesheetEditor.editing)
        {
            // Remove the editing flag to avoid recursion. The StylesheetEditor.endEditing
            // calls refresh and consequently updateLocation of the CSS panel.
            this.editing = null;

            // Stop the current editing.
            this.stopEditing();

            // ... and open the editor again.
            this.toggleEditing();
        }
    },

    updateSelection: function(object)
    {
        this.selection = null;

        if (object instanceof window.CSSStyleDeclaration)
        {
            object = object.parentRule;
        }

        if (object instanceof window.CSSStyleRule)
        {
            this.navigate(object.parentStyleSheet);
            this.highlightRule(object);
        }
        else if (object instanceof window.CSSStyleSheet)
        {
            this.navigate(object);
        }
        else if (object instanceof SourceLink.SourceLink)
        {
            try
            {
                var sourceLink = object;

                var sourceFile = Firebug.SourceFile.getSourceFileByHref(sourceLink.href, this.context);
                if (sourceFile)
                {
                    Dom.clearNode(this.panelNode);  // replace rendered stylesheets
                    this.showSourceFile(sourceFile);

                    var lineNo = object.line;
                    if (lineNo)
                        this.scrollToLine(lineNo, this.jumpHighlightFactory(lineNo, this.context));
                }
                else // XXXjjb we should not be taking this path
                {
                    var stylesheet = Css.getStyleSheetByHref(sourceLink.href, this.context);
                    if (stylesheet)
                    {
                        this.navigate(stylesheet);
                    }
                    else
                    {
                        if (FBTrace.DBG_CSS)
                            FBTrace.sysout("css.updateSelection no sourceFile for " +
                                sourceLink.href, sourceLink);
                    }
                }
            }
            catch(exc)
            {
                if (FBTrace.DBG_CSS)
                    FBTrace.sysout("css.upDateSelection FAILS "+exc, exc);
            }
        }
    },

    updateOption: function(name, value)
    {
        if (name == "expandShorthandProps")
            this.refresh();
    },

    getLocationList: function()
    {
        var styleSheets = Css.getAllStyleSheets(this.context);
        return styleSheets;
    },

    getOptionsMenuItems: function()
    {
        return [
            {
                label: "Expand Shorthand Properties",
                type: "checkbox",
                checked: Firebug.expandShorthandProps,
                command: Obj.bindFixed(Firebug.Options.togglePref,
                    Firebug.Options, "expandShorthandProps")
            },
            "-",
            {
                label: "Refresh",
                command: Obj.bind(this.refresh, this)
            }
        ];
    },

    getContextMenuItems: function(style, target)
    {
        var items = [];

        if (target.nodeName == "TEXTAREA")
        {
            items = Firebug.BaseEditor.getContextMenuItems();
            items.push(
                '-',
                {label: "Load Original Source",
                    command: Obj.bindFixed(this.loadOriginalSource, this) }
            );
            return items;
        }

        if (Css.hasClass(target, "cssSelector"))
        {
            items.push(
                {label: "Copy Rule Declaration", id: "fbCopyRuleDeclaration",
                    command: Obj.bindFixed(this.copyRuleDeclaration, this, target) },
                {label: "Copy Style Declaration", id: "fbCopyStyleDeclaration",
                    command: Obj.bindFixed(this.copyStyleDeclaration, this, target) }
            );
        }

        if (this.infoTipType == "color")
        {
            items.push(
                {label: "CopyColor",
                    command: Obj.bindFixed(System.copyToClipboard, System, this.infoTipObject) }
            );
        }
        else if (this.infoTipType == "image")
        {
            items.push(
                {label: "CopyImageLocation",
                    command: Obj.bindFixed(System.copyToClipboard, System, this.infoTipObject) },
                {label: "OpenImageInNewTab",
                    command: Obj.bindFixed(Win.openNewTab, Win, this.infoTipObject) }
            );
        }

        if (this.selection instanceof window.Element)
        {
            items.push(
                "-",
                {label: "EditStyle",
                    command: Obj.bindFixed(this.editElementStyle, this) }
            );
        }
        else if (!Url.isSystemStyleSheet(this.selection))
        {
            items.push(
                    "-",
                    {label: "NewRule",
                        command: Obj.bindFixed(this.insertRule, this, target) }
                );
        }

        var cssRule = Dom.getAncestorByClass(target, "cssRule");
        if (cssRule && Css.hasClass(cssRule, "cssEditableRule"))
        {
            items.push(
                "-",
                {label: "NewProp", id: "fbNewCSSProp",
                    command: Obj.bindFixed(this.insertPropertyRow, this, target) }
            );

            var propRow = Dom.getAncestorByClass(target, "cssProp");
            if (propRow)
            {
                var propName = Dom.getChildByClass(propRow, "cssPropName").textContent;
                var isDisabled = Css.hasClass(propRow, "disabledStyle");

                items.push(
                    {label: Locale.$STRF("EditProp", [propName]), nol10n: true,
                        command: Obj.bindFixed(this.editPropertyRow, this, propRow) },
                    {label: Locale.$STRF("DeleteProp", [propName]), nol10n: true,
                        command: Obj.bindFixed(this.deletePropertyRow, this, propRow) },
                    {label: Locale.$STRF("DisableProp", [propName]), nol10n: true,
                        type: "checkbox", checked: isDisabled,
                        command: Obj.bindFixed(this.disablePropertyRow, this, propRow) }
                );
            }
        }

        items.push(
            "-",
            {label: "Refresh", command: Obj.bind(this.refresh, this) }
        );

        return items;
    },

    browseObject: function(object)
    {
        if (this.infoTipType == "image")
        {
            Win.openNewTab(this.infoTipObject);
            return true;
        }
    },

    showInfoTip: function(infoTip, target, x, y, rangeParent, rangeOffset)
    {
        var propValue = Dom.getAncestorByClass(target, "cssPropValue");
        var propNameNode = target.parentNode.getElementsByClassName("cssPropName").item(0);

        if (propValue)
        {
            var text = propValue.textContent;
            if (propNameNode && (propNameNode.textContent.toLowerCase() == "font" ||
                propNameNode.textContent.toLowerCase() == "font-family"))
            {
                var cssValue = parseCssFontFamilyValue(text, rangeOffset);
            }
            else
            {
                var cssValue = parseCSSValue(text, rangeOffset);
            }

            if (cssValue)
            {
                if (cssValue.value == this.infoTipValue)
                    return true;

                this.infoTipValue = cssValue.value;

                if (cssValue.type == "rgb" || cssValue.type == "hsl" ||
                    cssValue.type == "gradient" ||
                    (!cssValue.type && Css.isColorKeyword(cssValue.value)))
                {
                    this.infoTipType = "color";
                    this.infoTipObject = cssValue.value;

                    return Firebug.InfoTip.populateColorInfoTip(infoTip, cssValue.value);
                }
                else if (cssValue.type == "url")
                {
                    var propNameNode = target.parentNode.getElementsByClassName("cssPropName").item(0);
                    if (propNameNode && Css.isImageRule(Xml.getElementSimpleType(
                        Firebug.getRepObject(target)),propNameNode.textContent))
                    {
                        var rule = Firebug.getRepObject(target);
                        var baseURL = this.getStylesheetURL(rule, true);
                        var relURL = parseURLValue(cssValue.value);
                        var absURL = Url.isDataURL(relURL) ? relURL : Url.absoluteURL(relURL, baseURL);
                        var repeat = parseRepeatValue(text);

                        this.infoTipType = "image";
                        this.infoTipObject = absURL;

                        return Firebug.InfoTip.populateImageInfoTip(infoTip, absURL, repeat);
                    }
                }
                else if (cssValue.type == "fontFamily") 
                {
                    return Firebug.InfoTip.populateFontFamilyTip(infoTip, cssValue.value);
                }
            } 
        }

        delete this.infoTipType;
        delete this.infoTipValue;
        delete this.infoTipObject;
    },

    getEditor: function(target, value)
    {
        if (target == this.panelNode
            || Css.hasClass(target, "cssSelector") || Css.hasClass(target, "cssRule")
            || Css.hasClass(target, "cssSheet"))
        {
            if (!this.ruleEditor)
                this.ruleEditor = new CSSRuleEditor(this.document);

            return this.ruleEditor;
        }
        else
        {
            if (!this.editor)
                this.editor = new CSSEditor(this.document);

            return this.editor;
        }
    },

    getDefaultLocation: function()
    {
        try
        {
            var styleSheets = this.context.window.document.styleSheets;
            if (styleSheets.length)
            {
                var sheet = styleSheets[0];
                return (Firebug.filterSystemURLs &&
                    Url.isSystemURL(Css.getURLForStyleSheet(sheet))) ? null : sheet;
            }
        }
        catch (exc)
        {
            if (FBTrace.DBG_LOCATIONS)
                FBTrace.sysout("css.getDefaultLocation FAILS "+exc, exc);
        }
    },

    getObjectLocation: function(styleSheet)
    {
        return Css.getURLForStyleSheet(styleSheet);
    },

    getObjectDescription: function(styleSheet)
    {
        var url = Css.getURLForStyleSheet(styleSheet);
        var instance = Css.getInstanceForStyleSheet(styleSheet);

        var baseDescription = Url.splitURLBase(url);
        if (instance) {
          baseDescription.name = baseDescription.name + " #" + (instance + 1);
        }
        return baseDescription;
    },

    getSourceLink: function(target, rule)
    {
        var element = rule.parentStyleSheet.ownerNode;
        var href = rule.parentStyleSheet.href;  // Null means inline
        if (!href)
            href = element.ownerDocument.location.href;  // http://code.google.com/p/fbug/issues/detail?id=452

        var line = getRuleLine(rule);
        var instance = Css.getInstanceForStyleSheet(rule.parentStyleSheet);
        var sourceLink = new SourceLink.SourceLink(href, line, "css", rule, instance);

        return sourceLink;
    },

    getTopmostRuleLine: function()
    {
        var panelNode = this.panelNode;
        for (var child = panelNode.firstChild; child; child = child.nextSibling)
        {
            if (child.offsetTop+child.offsetHeight > panelNode.scrollTop)
            {
                var rule = child.repObject;
                if (rule)
                    return {
                        line: getRuleLine(rule),
                        offset: panelNode.scrollTop-child.offsetTop
                    };
            }
        }
        return 0;
    },

    getCurrentLineNumber: function()
    {
        var ruleLine = this.getTopMostRuleLine();
        if (ruleLine)
            return ruleLine.line;
    },

    search: function(text, reverse)
    {
        var curDoc = this.searchCurrentDoc(!Firebug.searchGlobal, text, reverse);
        if (!curDoc && Firebug.searchGlobal)
        {
            return this.searchOtherDocs(text, reverse) ||
                this.searchCurrentDoc(true, text, reverse);
        }
        return curDoc;
    },

    searchOtherDocs: function(text, reverse)
    {
        var scanRE = Firebug.Search.getTestingRegex(text);
        function scanDoc(styleSheet) {
            // we don't care about reverse here as we are just looking for existence,
            // if we do have a result we will handle the reverse logic on display
            for (var i = 0; i < styleSheet.cssRules.length; i++)
            {
                if (scanRE.test(styleSheet.cssRules[i].cssText))
                {
                    return true;
                }
            }
        }

        if (this.navigateToNextDocument(scanDoc, reverse))
        {
            // firefox findService can't find nodes immediatly after insertion
            setTimeout(Obj.bind(this.searchCurrentDoc, this), 0, true, text, reverse);
            return "wraparound";
        }
    },

    searchCurrentDoc: function(wrapSearch, text, reverse)
    {
        var row, sel;

        if (!text)
        {
            delete this.currentSearch;
            this.highlightNode(null);
            this.document.defaultView.getSelection().removeAllRanges();
            return false;
        }

        if (this.currentSearch && text == this.currentSearch.text)
        {
            row = this.currentSearch.findNext(wrapSearch, false, reverse,
                Firebug.Search.isCaseSensitive(text));
        }
        else
        {
            if (this.editing)
            {
                this.currentSearch = new Search.TextSearch(this.stylesheetEditor.box);
                row = this.currentSearch.find(text, reverse, Firebug.Search.isCaseSensitive(text));

                if (row)
                {
                    sel = this.document.defaultView.getSelection();
                    sel.removeAllRanges();
                    sel.addRange(this.currentSearch.range);

                    scrollSelectionIntoView(this);
                    this.highlightNode(row);

                    return true;
                }
                else
                    return false;
            }
            else
            {
                function findRow(node) { return node.nodeType == 1 ? node : node.parentNode; }
                this.currentSearch = new Search.TextSearch(this.panelNode, findRow);
                row = this.currentSearch.find(text, reverse, Firebug.Search.isCaseSensitive(text));
            }
        }

        if (row)
        {
            sel = this.document.defaultView.getSelection();
            sel.removeAllRanges();
            sel.addRange(this.currentSearch.range);

            // Should be replaced by scrollToLine() of sourceBox,
            // though first jumpHighlightFactory() has to be adjusted to
            // remove the current highlighting when called again
            Dom.scrollIntoCenterView(row, this.panelNode);
            this.highlightNode(row.parentNode);

            Events.dispatch(this.fbListeners, "onCSSSearchMatchFound", [this, text, row]);
            return this.currentSearch.wrapped ? "wraparound" : true;
        }
        else
        {
            this.document.defaultView.getSelection().removeAllRanges();
            Events.dispatch(this.fbListeners, "onCSSSearchMatchFound", [this, text, null]);
            return false;
        }
    },

    getSearchOptionsMenuItems: function()
    {
        return [
            Firebug.Search.searchOptionMenu("search.Case Sensitive", "searchCaseSensitive"),
            Firebug.Search.searchOptionMenu("search.Multiple Files", "searchGlobal"),
            Firebug.Search.searchOptionMenu("search.Use Regular Expression", "searchUseRegularExpression")
        ];
    },

    getStyleDeclaration: function(cssSelector)
    {
        var cssRule = Dom.getAncestorByClass(cssSelector, "cssRule");
        var cssRules = cssRule.getElementsByClassName("cssPropertyListBox")[0].rule;
        var props = [];

        for (var p in cssRules.props)
        {
            var prop = cssRules.props[p];
            if (!(prop.disabled || prop.overridden))
                props.push(prop.name + ": " + prop.value + prop.important + ";");
        }

        return props;
    },

    copyRuleDeclaration: function(cssSelector)
    {
        var props = this.getStyleDeclaration(cssSelector);
        System.copyToClipboard(cssSelector.textContent + " {" + Str.lineBreak() + "  " +
            props.join(Str.lineBreak() + "  ") + Str.lineBreak() + "}");
    },

    copyStyleDeclaration: function(cssSelector)
    {
        var props = this.getStyleDeclaration(cssSelector);
        System.copyToClipboard(props.join(Str.lineBreak()));
    }
});

// ********************************************************************************************* //

function CSSElementPanel() {}

CSSElementPanel.prototype = Obj.extend(Firebug.CSSStyleSheetPanel.prototype,
{
    template: domplate(
    {
        cascadedTag:
            DIV({"class": "a11yCSSView", role: "presentation"},
                DIV({role: "list", "aria-label": Locale.$STR("aria.labels.style rules") },
                    FOR("rule", "$rules",
                        TAG("$ruleTag", {rule: "$rule"})
                    )
                ),
                DIV({role: "list", "aria-label": Locale.$STR("aria.labels.inherited style rules")},
                    FOR("section", "$inherited",
                        H1({"class": "cssInheritHeader groupHeader focusRow", role: "listitem" },
                            SPAN({"class": "cssInheritLabel"}, "$inheritLabel"),
                            TAG(FirebugReps.Element.shortTag, {object: "$section.element"})
                        ),
                        DIV({role: "group"},
                            FOR("rule", "$section.rules",
                                TAG("$ruleTag", {rule: "$rule"})
                            )
                        )
                    )
                 )
            ),

        ruleTag:
            DIV({"class": "cssElementRuleContainer"},
                TAG(CSSStyleRuleTag.tag, {rule: "$rule"}),
                TAG(FirebugReps.SourceLink.tag, {object: "$rule.sourceLink"})
            )
    }),

    // * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * //
    // All calls to this method must call cleanupSheets first

    updateCascadeView: function(element)
    {
        var result, warning, inheritLabel;

        Events.dispatch(this.fbListeners, 'onBeforeCSSRulesAdded', [this]);
        var rules = [], sections = [], usedProps = {};
        this.getInheritedRules(element, sections, usedProps);
        this.getElementRules(element, rules, usedProps);

        if (rules.length || sections.length)
        {
            if (Firebug.onlyShowAppliedStyles)
                this.removeOverriddenProps(rules, sections);

            inheritLabel = Locale.$STR("InheritedFrom");
            result = this.template.cascadedTag.replace({rules: rules, inherited: sections,
                inheritLabel: inheritLabel}, this.panelNode);
            Events.dispatch(this.fbListeners, 'onCSSRulesAdded', [this, result]);
        }
        else
        {
            warning = FirebugReps.Warning.tag.replace({object: ""}, this.panelNode);
            result = FirebugReps.Description.render(Locale.$STR("css.EmptyElementCSS"),
                warning, Obj.bind(this.editElementStyle, this));
            Events.dispatch([Firebug.A11yModel], 'onCSSRulesAdded', [this, result]);
        }
    },

    getStylesheetURL: function(rule, getBaseUri)
    {
        // if the parentStyleSheet.href is null, CSS std says its inline style
        if (rule && rule.parentStyleSheet && rule.parentStyleSheet.href)
            return rule.parentStyleSheet.href;
        else if (getBaseUri)
            return this.selection.ownerDocument.baseURI;
        else
            return this.selection.ownerDocument.location.href;
    },

    // * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * //
    // All calls to this method must call cleanupSheets first

    getInheritedRules: function(element, sections, usedProps)
    {
        var parent = element.parentNode;
        if (parent && parent.nodeType == 1)
        {
            this.getInheritedRules(parent, sections, usedProps);

            var rules = [];
            this.getElementRules(parent, rules, usedProps, true);

            if (rules.length)
                sections.splice(0, 0, {element: parent, rules: rules});
        }
    },

    // All calls to this method must call cleanupSheets first
    getElementRules: function(element, rules, usedProps, inheritMode)
    {
        var pseudoElements = [""];
        var inspectedRules, displayedRules = {};

        // Firefox 6+ allows inspecting of pseudo-elements (see issue 537)
        if (DOMUTILS_SUPPORTS_PSEUDOELEMENTS && !inheritMode)
            pseudoElements = Arr.extendArray(pseudoElements,
                [":first-letter", ":first-line", ":before", ":after"]);

        for (var p in pseudoElements)
        {
            try
            {
                inspectedRules = Dom.domUtils.getCSSStyleRules(element, pseudoElements[p]);
            }
            catch (exc)
            {
                continue;
            }

            if (!inspectedRules)
                continue;

            for (var i = 0; i < inspectedRules.Count(); ++i)
            {
                var rule = Xpcom.QI(inspectedRules.GetElementAt(i), nsIDOMCSSStyleRule);

                var isSystemSheet = Url.isSystemStyleSheet(rule.parentStyleSheet);
                if (!Firebug.showUserAgentCSS && isSystemSheet) // This removes user agent rules
                    continue;

                var props = this.getRuleProperties(this.context, rule, inheritMode);
                if (inheritMode && !props.length)
                    continue;

                var isPseudoElementSheet = (pseudoElements[p] != "");
                var sourceLink = this.getSourceLink(null, rule);

                if (!isPseudoElementSheet)
                    this.markOverriddenProps(props, usedProps, inheritMode);

                var ruleId = getRuleId(rule);
                rules.splice(0, 0, {rule: rule, id: ruleId,
                    // Show universal selectors with pseudo-class
                    // (http://code.google.com/p/fbug/issues/detail?id=3683)
                    selector: rule.selectorText.replace(/ :/g, " *:"),
                    sourceLink: sourceLink,
                    props: props, inherited: inheritMode,
                    isSystemSheet: isSystemSheet,
                    isPseudoElementSheet: isPseudoElementSheet,
                    isSelectorEditable: true
                });
            }
        }

        if (element.style)
            this.getStyleProperties(element, rules, usedProps, inheritMode);

//        if (FBTrace.DBG_CSS)
//            FBTrace.sysout("getElementRules "+rules.length+" rules for "+
//                Xpath.getElementXPath(element), rules);
    },

    markOverriddenProps: function(props, usedProps, inheritMode)
    {
        for (var i = 0; i < props.length; ++i)
        {
            var prop = props[i];
            if ( usedProps.hasOwnProperty(prop.name) )
            {
                var deadProps = usedProps[prop.name]; // all previous occurrences of this property
                for (var j = 0; j < deadProps.length; ++j)
                {
                    var deadProp = deadProps[j];
                    if (!deadProp.disabled && !deadProp.wasInherited && deadProp.important &&
                        !prop.important && prop.value.indexOf("%") == -1)
                    {
                        prop.overridden = true;  // new occurrence overridden
                    }
                    else if (!prop.disabled &&
                        (!deadProp.wasInherited || prop.value.indexOf("%") == -1))
                    {
                        deadProp.overridden = true;  // previous occurrences overridden
                    }
                }
            }
            else
                usedProps[prop.name] = [];

            prop.wasInherited = inheritMode ? true : false;
            usedProps[prop.name].push(prop);  // all occurrences of a property seen so far, by name
        }
    },

    removeOverriddenProps: function(rules, sections)
    {
        function removeProps(rules)
        {
            var i=0;
            while (i<rules.length)
            {
                var props = rules[i].props;

                var j=0;
                while (j<props.length)
                {
                    if (props[j].overridden)
                        props.splice(j, 1);
                    else
                        ++j;
                }

                if (props.length == 0)
                    rules.splice(i, 1);
                else
                    ++i;
            }
        }

        removeProps(rules);

        var i=0;
        while (i<sections.length)
        {
            var section = sections[i];
            removeProps(section.rules);

            if (section.rules.length == 0)
                sections.splice(i, 1);
            else
                ++i;
        }
    },

    getStyleProperties: function(element, rules, usedProps, inheritMode)
    {
        var props = this.parseCSSProps(element.style, inheritMode);
        this.addOldProperties(this.context, Xpath.getElementXPath(element), inheritMode, props);

        sortProperties(props);
        this.markOverriddenProps(props, usedProps, inheritMode);

        if (props.length)
            rules.splice(0, 0,
                    {rule: element, id: Xpath.getElementXPath(element),
                        selector: "element.style", props: props, inherited: inheritMode});
    },

    // * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * //
    // extends Panel

    name: "css",
    parentPanel: "html",
    order: 0,

    initialize: function()
    {
        this.onMouseDown = Obj.bind(this.onMouseDown, this);
        this.onClick = Obj.bind(this.onClick, this);
        this.onStateChange = Obj.bindFixed(this.contentStateCheck, this);
        this.onHoverChange = Obj.bindFixed(this.contentStateCheck, this, STATE_HOVER);
        this.onActiveChange = Obj.bindFixed(this.contentStateCheck, this, STATE_ACTIVE);

        // We only need the basic panel initialize, not the intermeditate objects
        Firebug.Panel.initialize.apply(this, arguments);
    },

    show: function(state)
    {
    },

    watchWindow: function(win)
    {
        if (Dom.domUtils)
        {
            // Normally these would not be required, but in order to update after the state is set
            // using the options menu we need to monitor these global events as well
            var doc = win.document;
            Events.addEventListener(doc, "mouseover", this.onHoverChange, false);
            Events.addEventListener(doc, "mousedown", this.onActiveChange, false);
        }
    },

    unwatchWindow: function(win)
    {
        var doc = win.document;
        Events.removeEventListener(doc, "mouseover", this.onHoverChange, false);
        Events.removeEventListener(doc, "mousedown", this.onActiveChange, false);

        if (Dom.isAncestor(this.stateChangeEl, doc))
        {
            this.removeStateChangeHandlers();
        }
    },

    supportsObject: function(object, type)
    {
        return object instanceof window.Element ? 1 : 0;
    },

    updateView: function(element)
    {
        Firebug.CSSModule.cleanupSheets(element.ownerDocument, Firebug.currentContext);
        this.updateCascadeView(element);
        if (Dom.domUtils)
        {
            this.contentState = safeGetContentState(element);
            this.addStateChangeHandlers(element);
        }
    },

    updateSelection: function(element)
    {
        if ( !(element instanceof window.Element) ) // html supports SourceLink
            return;

        var sothinkInstalled = !!Firefox.getElementById("swfcatcherKey_sidebar");
        if (sothinkInstalled)
        {
            var div = FirebugReps.Warning.tag.replace({object: "SothinkWarning"}, this.panelNode);
            div.innerHTML = Locale.$STR("SothinkWarning");
            return;
        }

        if (!element)
            return;

        this.updateView(element);
    },

    updateOption: function(name, value)
    {
        if (name == "showUserAgentCSS" || name == "expandShorthandProps" ||
            name == "onlyShowAppliedStyles")
        {
            this.refresh();
        }
    },

    getOptionsMenuItems: function()
    {
        var ret = [
            {
                label: "Only Show Applied Styles",
                type: "checkbox",
                checked: Firebug.onlyShowAppliedStyles,
                command: Obj.bindFixed(Firebug.Options.togglePref, Firebug.Options,
                    "onlyShowAppliedStyles")
            },
            {
                label: "Show User Agent CSS",
                type: "checkbox",
                checked: Firebug.showUserAgentCSS,
                command: Obj.bindFixed(Firebug.Options.togglePref, Firebug.Options,
                    "showUserAgentCSS")
            },
            {
                label: "Expand Shorthand Properties",
                type: "checkbox",
                checked: Firebug.expandShorthandProps,
                command: Obj.bindFixed(Firebug.Options.togglePref, Firebug.Options,
                    "expandShorthandProps")
            }
        ];

        if (Dom.domUtils && this.selection)
        {
            var state = safeGetContentState(this.selection);
            var self = this;

            ret.push("-");

            ret.push({label: ":active", type: "checkbox", checked: state & STATE_ACTIVE,
                command: function() {
                    self.updateContentState(STATE_ACTIVE, !this.getAttribute("checked"));
                }
            });

            ret.push({label: ":hover", type: "checkbox", checked: state & STATE_HOVER,
                command: function() {
                    self.updateContentState(STATE_HOVER, !this.getAttribute("checked"));
                }
            });
        }

        return ret;
    },

    updateContentState: function(state, remove)
    {
        if (FBTrace.DBG_CSS)
            FBTrace.sysout("css.updateContentState; state: " + state + ", remove: " + remove);

        Dom.domUtils.setContentState(remove ? this.selection.ownerDocument.documentElement :
            this.selection, state);

        this.refresh();
    },

    addStateChangeHandlers: function(el)
    {
      this.removeStateChangeHandlers();

      Events.addEventListener(el, "focus", this.onStateChange, true);
      Events.addEventListener(el, "blur", this.onStateChange, true);
      Events.addEventListener(el, "mouseup", this.onStateChange, false);
      Events.addEventListener(el, "mousedown", this.onStateChange, false);
      Events.addEventListener(el, "mouseover", this.onStateChange, false);
      Events.addEventListener(el, "mouseout", this.onStateChange, false);

      this.stateChangeEl = el;
    },

    removeStateChangeHandlers: function()
    {
        var sel = this.stateChangeEl;
        if (sel)
        {
            Events.removeEventListener(sel, "focus", this.onStateChange, true);
            Events.removeEventListener(sel, "blur", this.onStateChange, true);
            Events.removeEventListener(sel, "mouseup", this.onStateChange, false);
            Events.removeEventListener(sel, "mousedown", this.onStateChange, false);
            Events.removeEventListener(sel, "mouseover", this.onStateChange, false);
            Events.removeEventListener(sel, "mouseout", this.onStateChange, false);
        }
    },

    contentStateCheck: function(state)
    {
      if (!state || this.contentState & state)
      {
          var timeoutRunner = Obj.bindFixed(function()
              {
                  var newState = safeGetContentState(this.selection);
                  if (newState != this.contentState)
                  {
                      this.context.invalidatePanels(this.name);
                  }
              }, this);

          // Delay exec until after the event has processed and the state has been updated
          setTimeout(timeoutRunner, 0);
      }
    }
});

function safeGetContentState(selection)
{
    try
    {
        if (selection && selection.ownerDocument)
            return Dom.domUtils.getContentState(selection);
    }
    catch (e)
    {
        if (FBTrace.DBG_ERRORS && FBTrace.DBG_CSS)
            FBTrace.sysout("css.safeGetContentState; EXCEPTION "+e, e);
    }
}

// ********************************************************************************************* //

function CSSComputedElementPanel() {}

CSSComputedElementPanel.prototype = Obj.extend(CSSElementPanel.prototype,
{
    template: domplate(
    {
        computedTag:
            DIV({"class": "a11yCSSView", role: "list", "aria-label":
                Locale.$STR("aria.labels.computed styles")},
                FOR("group", "$groups",
                    DIV({"class": "computedStylesGroup", $opened: "$group.opened", role: "list"},
                        H1({"class": "cssComputedHeader groupHeader focusRow", role: "listitem"},
                            IMG({"class": "twisty", role: "presentation"}),
                            SPAN({"class": "cssComputedLabel"}, "$group.title")
                        ),
                        TAG("$stylesTag", {props: "$group.props"})
                    )
                )
            ),

        computedAlphabeticalTag:
            DIV({"class": "a11yCSSView", role: "list",
                "aria-label" : Locale.$STR("aria.labels.computed styles")},
                TAG("$stylesTag", {props: "$props"})
            ),

        stylesTag:
            TABLE({width: "100%", role: "group"},
                TBODY({role: "presentation"},
                    FOR("prop", "$props",
                        TR({"class": "focusRow computedStyleRow", role: "listitem"},
                            TD({"class": "stylePropName", role: "presentation"}, "$prop.name"),
                            TD({"class": "stylePropValue", role: "presentation"}, "$prop.value")
                        )
                    )
                )
            )
    }),

    // * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * //

    updateComputedView: function(element)
    {
        if (FBTrace.DBG_CSS)
            FBTrace.sysout("CSSComputedElementPanel.updateComputedView;", element);

        var win = element.ownerDocument.defaultView;
        var style = win.getComputedStyle(element, "");

        if (Firebug.computedStylesDisplay == "alphabetical")
        {
            var props = [];

            for (var groupName in styleGroups)
            {
                var groupProps = styleGroups[groupName];

                for (var i = 0; i < groupProps.length; ++i)
                {
                    var propName = groupProps[i];
                    if (!Firebug.showMozillaSpecificStyles && propName.match(/^-moz/))
                        continue;

                    var propValue = stripUnits(rgbToHex(style.getPropertyValue(propName)));
                    if (propValue)
                        props.push({name: propName, value: propValue});
                }
            }
            sortProperties(props);

            var result = this.template.computedAlphabeticalTag.replace(
                {props: props}, this.panelNode);
        }
        else
        {
            var groups = [];

            for (var groupName in styleGroups)
            {
                var title = Locale.$STR("StyleGroup-" + groupName);
                var group = {title: title, props: []};
                groups.push(group);

                var props = styleGroups[groupName];
                for (var i = 0; i < props.length; ++i)
                {
                    var propName = props[i];
                    if (!Firebug.showMozillaSpecificStyles && propName.match(/^-moz/))
                      continue;

                    var propValue = stripUnits(rgbToHex(style.getPropertyValue(propName)));
                    if (propValue)
                        group.props.push({name: propName, value: propValue});
                }
                group.opened = this.groupOpened[title];
            }

            var result = this.template.computedTag.replace({groups: groups}, this.panelNode);
        }

        Events.dispatch(this.fbListeners, 'onCSSRulesAdded', [this, result]);
    },

    // * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * //
    // extends Panel

    name: "computed",
    parentPanel: "html",
    order: 1,

    initialize: function()
    {
        this.groupOpened = [];
        for (var groupName in styleGroups)
        {
            var title = Locale.$STR("StyleGroup-" + groupName);
            this.groupOpened[title] = true;
        }

        this.onClick = Obj.bind(this.onClick, this);
        this.onMouseDown = Obj.bind(this.onMouseDown, this);

        // Listen for CSS changes so the Computed panel is properly updated when needed.
        Firebug.CSSModule.addListener(this);

        CSSElementPanel.prototype.initialize.apply(this, arguments);
    },

    destroy: function()
    {
        Firebug.CSSModule.removeListener(this);

        CSSElementPanel.prototype.destroy.apply(this, arguments);
    },

    updateView: function(element)
    {
        this.updateComputedView(element);
    },

    updateOption: function(name, value)
    {
        if (name == "computedStylesDisplay" || name == "showMozillaSpecificStyles")
            this.refresh();
    },

    getOptionsMenuItems: function()
    {
        return [
            {
                label: "Sort alphabetically",
                type: "checkbox",
                checked: Firebug.computedStylesDisplay == "alphabetical",
                command: Obj.bind(this.toggleDisplay, this)
            },
            {
                label: "Show Mozilla specific styles",
                type: "checkbox",
                checked: Firebug.showMozillaSpecificStyles,
                command: Obj.bindFixed(Firebug.Options.togglePref,
                    Firebug.Options, "showMozillaSpecificStyles")
            },
            "-",
            {
                label: "Refresh", command: Obj.bind(this.refresh, this)
            }
        ];
    },

    onMouseDown: function(event)
    {
        if (!Events.isLeftClick(event))
            return;

        var cssComputedHeader = Dom.getAncestorByClass(event.target, "cssComputedHeader");
        if (cssComputedHeader)
            this.toggleNode(event);
    },

    toggleNode: function(event)
    {
        var group = Dom.getAncestorByClass(event.target, "computedStylesGroup");
        var groupName = group.getElementsByClassName("cssComputedLabel")[0].textContent;

        Css.toggleClass(group, "opened");
        this.groupOpened[groupName] = Css.hasClass(group, "opened");
    },

    toggleDisplay: function()
    {
        var display = Firebug.computedStylesDisplay == "alphabetical" ? "grouped" : "alphabetical";
        Firebug.Options.set("computedStylesDisplay", display);
    },

    // * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * //
    // Change Listener

    onCSSInsertRule: function(styleSheet, cssText, ruleIndex)
    {
        // Force update, this causes updateSelection to be called.
        // See {@link Firebug.Panel.select}
        this.selection = null;
    },

    onCSSDeleteRule: function(styleSheet, ruleIndex)
    {
        this.selection = null;
    },

    onCSSSetProperty: function(style, propName, propValue, propPriority, prevValue,
        prevPriority, rule, baseText)
    {
        this.selection = null;
    },

    onCSSRemoveProperty: function(style, propName, prevValue, prevPriority, rule, baseText)
    {
        this.selection = null;
    }
});

// ********************************************************************************************* //
// CSSEditor

function CSSEditor(doc)
{
    this.initializeInline(doc);
}

CSSEditor.prototype = domplate(Firebug.InlineEditor.prototype,
{
    insertNewRow: function(target, insertWhere)
    {
        var rule = Firebug.getRepObject(target);
        if (!rule)
        {
            if (FBTrace.DBG_CSS)
                FBTrace.sysout("CSSEditor.insertNewRow; ERROR There is no CSS rule", target);
            return;
        }

        var emptyProp = {name: "", value: "", important: ""};

        if (insertWhere == "before")
            return CSSPropTag.tag.insertBefore({prop: emptyProp, rule: rule}, target);
        else
            return CSSPropTag.tag.insertAfter({prop: emptyProp, rule: rule}, target);
    },

    saveEdit: function(target, value, previousValue)
    {
        var propValue, parsedValue, propName;

        target.innerHTML = Str.escapeForCss(value);

        var row = Dom.getAncestorByClass(target, "cssProp");
        if (Css.hasClass(row, "disabledStyle"))
            Css.toggleClass(row, "disabledStyle");

        var rule = Firebug.getRepObject(target);

        if (Css.hasClass(target, "cssPropName"))
        {
            if (value && previousValue != value)  // name of property has changed.
            {
                propValue = Dom.getChildByClass(row, "cssPropValue").textContent;
                parsedValue = parsePriority(propValue);

                if (propValue && propValue != "undefined")
                {
                    if (FBTrace.DBG_CSS)
                        FBTrace.sysout("CSSEditor.saveEdit : "+previousValue+"->"+value+
                            " = "+propValue+"\n");

                    if (previousValue)
                        Firebug.CSSModule.removeProperty(rule, previousValue);

                    Firebug.CSSModule.setProperty(rule, value, parsedValue.value,
                        parsedValue.priority);
                }
            }
            else if (!value) // name of the property has been deleted, so remove the property.
                Firebug.CSSModule.removeProperty(rule, previousValue);
        }
        else if (Dom.getAncestorByClass(target, "cssPropValue"))
        {
            propName = Dom.getChildByClass(row, "cssPropName").textContent;
            propValue = Dom.getChildByClass(row, "cssPropValue").textContent;

            if (FBTrace.DBG_CSS)
            {
                FBTrace.sysout("CSSEditor.saveEdit propName=propValue: "+propName +
                    " = "+propValue+"\n");
               // FBTrace.sysout("CSSEditor.saveEdit BEFORE style:",style);
            }

            if (value && value != "null")
            {
                parsedValue = parsePriority(value);
                Firebug.CSSModule.setProperty(rule, propName, parsedValue.value,
                    parsedValue.priority);
            }
            else if (previousValue && previousValue != "null")
                Firebug.CSSModule.removeProperty(rule, propName);
        }

        if (value)
        {
            var saveSuccess = !!rule.style.getPropertyValue(propName || value);
            if(!saveSuccess && !propName)
            {
                propName = value.replace(/-./g, function(match) match[1].toUpperCase());
                if(propName in rule.style || propName == "float")
                    saveSuccess = "almost";
            }
            this.box.setAttribute("saveSuccess",saveSuccess);
        }
        else
            this.box.removeAttribute("saveSuccess");

        Firebug.Inspector.repaint();

        this.panel.markChange(this.panel.name == "stylesheet");
    },

    advanceToNext: function(target, charCode)
    {
        if (charCode == 58 /*":"*/ && Css.hasClass(target, "cssPropName"))
        {
            return true;
        }
        else if (charCode == 59 /*";"*/ && Css.hasClass(target, "cssPropValue"))
        {
            var cssValue = parseCSSValue(this.input.value, this.input.selectionStart);
            // Simple test, if we are inside a string (see issue 4543)
            var isValueInString = (cssValue.value.indexOf("\"") != -1);

            return !isValueInString;
        }
    },

    // * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * *

    getAutoCompleteRange: function(value, offset)
    {
        if (Css.hasClass(this.target, "cssPropName"))
            return {start: 0, end: value.length-1};
        else
            return parseCSSValue(value, offset);
    },

    getAutoCompleteList: function(preExpr, expr, postExpr)
    {
        if (expr.indexOf("!") == 0)
        {
            return ["!important"];
        }
        else if (Css.hasClass(this.target, "cssPropName"))
        {
            return Css.getCSSPropertyNames(Xml.getElementSimpleType(Firebug.getRepObject(this.target)));
        }
        else
        {
            var row = Dom.getAncestorByClass(this.target, "cssProp");
            var propName = Dom.getChildByClass(row, "cssPropName").textContent;
            return Css.getCSSKeywordsByProperty(Xml.getElementSimpleType(
                Firebug.getRepObject(this.target)),propName);
        }
    },

    reValidCSSToken: /^[A-Za-z_$\-][A-Za-z_$\-0-9]*/,

    isValidAutoCompleteProperty: function(value)
    {
        return this.reValidCSSToken.test(value);
    }
});

// ********************************************************************************************* //
// CSSRuleEditor

function CSSRuleEditor(doc)
{
    this.initializeInline(doc);
    this.completeAsYouType = false;
}

CSSRuleEditor.uniquifier = 0;
CSSRuleEditor.prototype = domplate(Firebug.InlineEditor.prototype,
{
    insertNewRow: function(target, insertWhere)
    {
        var emptyRule = {
            selector: "",
            id: "",
            props: [],
            isSelectorEditable: true
        };

        if (insertWhere == "before")
            return CSSStyleRuleTag.tag.insertBefore({rule: emptyRule}, target);
        else
            return CSSStyleRuleTag.tag.insertAfter({rule: emptyRule}, target);
    },

    saveEdit: function(target, value, previousValue)
    {
        if (FBTrace.DBG_CSS)
            FBTrace.sysout("CSSRuleEditor.saveEdit: '" + value + "'  '" + previousValue +
                "'", target);

        target.innerHTML = Str.escapeForCss(value);

        if (value === previousValue)
            return;

        var row = Dom.getAncestorByClass(target, "cssRule");

        var rule = Firebug.getRepObject(target);
        var searchRule = rule || Firebug.getRepObject(row.nextSibling);
        var oldRule, ruleIndex;

        if (searchRule)
        {
            // take care of media rules
            var styleSheet = searchRule.parentRule || searchRule.parentStyleSheet;
            if(!styleSheet)
                return;

            var cssRules = styleSheet.cssRules;
            for (ruleIndex=0; ruleIndex<cssRules.length && searchRule!=cssRules[ruleIndex];
                ruleIndex++)
            {
            }

            if (rule)
                oldRule = searchRule;
            else
                ruleIndex++;
        }
        else
        {
            if (this.panel.name != 'stylesheet')
                return;

            var styleSheet = this.panel.location;//this must be stylesheet panel
            if (!styleSheet)
            {
                // If there is no stylesheet on the page we need to create a temporary one,
                // in order to make a place where to put (custom) user provided rules.
                // If this code would be in this.getDefaultLocation the default stylesheet
                // would be created automatically for all pages with not styles, which
                // could be damaging for special pages (see eg issue 2440)
                // At this moment the user edits the styles so some CSS changes on the page
                // are expected.
                var doc = this.panel.context.window.document;
                var style = Css.appendStylesheet(doc, "chrome://firebug/default-stylesheet.css");
                Wrapper.getContentView(style).defaultStylesheet = true;
                this.panel.location = styleSheet = style.sheet;
            }

            styleSheet = styleSheet.editStyleSheet ? styleSheet.editStyleSheet.sheet : styleSheet;
            cssRules = styleSheet.cssRules;
            ruleIndex = cssRules.length;
        }

        // Delete in all cases except for new add
        // We want to do this before the insert to ease change tracking
        if (oldRule)
        {
            Firebug.CSSModule.deleteRule(styleSheet, ruleIndex);
        }

        // Firefox does not follow the spec for the update selector text case.
        // When attempting to update the value, firefox will silently fail.
        // See https://bugzilla.mozilla.org/show_bug.cgi?id=37468 for the quite
        // old discussion of this bug.
        // As a result we need to recreate the style every time the selector
        // changes.
        if (value)
        {
            var cssText = [ value, "{", ];
            var props = row.getElementsByClassName("cssProp");
            for (var i = 0; i < props.length; i++)
            {
                var propEl = props[i];
                if (!Css.hasClass(propEl, "disabledStyle"))
                {
                    cssText.push(Dom.getChildByClass(propEl, "cssPropName").textContent);
                    cssText.push(":");
                    cssText.push(Dom.getChildByClass(propEl, "cssPropValue").textContent);
                    cssText.push(";");
                }
            }

            cssText.push("}");
            cssText = cssText.join("");

            try
            {
                var insertLoc = Firebug.CSSModule.insertRule(styleSheet, cssText, ruleIndex);
                rule = cssRules[insertLoc];
                ruleIndex++;

                var saveSuccess = this.panel.name != "css";
                if (!saveSuccess)
                    saveSuccess =(this.panel.selection &&
                        this.panel.selection.mozMatchesSelector(value))? true: 'almost';

                this.box.setAttribute('saveSuccess',saveSuccess);
            }
            catch (err)
            {
                if (FBTrace.DBG_CSS || FBTrace.DBG_ERRORS)
                    FBTrace.sysout("CSS Insert Error: "+err, err);

                target.innerHTML = Str.escapeForCss(previousValue);
                // create dummy rule to be able to recover from error
                var insertLoc = Firebug.CSSModule.insertRule(styleSheet,
                    'selectorSavingError{}', ruleIndex);
                rule = cssRules[insertLoc];

                this.box.setAttribute('saveSuccess',false);

                row.repObject = rule;
                return;
            }
        }
        else
        {
            rule = undefined;
        }

        // Update the rep object
        row.repObject = rule;
        if (!oldRule)
        {
            // Who knows what the domutils will return for rule line
            // for a recently created rule. To be safe we just generate
            // a unique value as this is only used as an internal key.
            var ruleId = "new/"+value+"/"+(++CSSRuleEditor.uniquifier);
            row.setAttribute("ruleId", ruleId);
        }

        this.panel.markChange(this.panel.name == "stylesheet");
    },

    advanceToNext: function(target, charCode)
    {
        if (charCode == 123 /* "{" */)
        {
            return true;
        }
    }
});

// ********************************************************************************************* //
// StyleSheetEditor

/**
 * StyleSheetEditor represents an inline editor and is used when editing CSS
 * within the CSS panel.
 */
function StyleSheetEditor(doc)
{
    this.box = this.tag.replace({}, doc, this);
    this.input = this.box.firstChild;
}

StyleSheetEditor.prototype = domplate(Firebug.BaseEditor,
{
    multiLine: true,

    tag: DIV(
        TEXTAREA({"class": "styleSheetEditor fullPanelEditor", oninput: "$onInput"})
    ),

    // * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * //

    getValue: function()
    {
        return this.input.value;
    },

    setValue: function(value)
    {
        return this.input.value = value;
    },

    show: function(target, panel, value, textSize)
    {
        this.target = target;
        this.panel = panel;

        this.panel.panelNode.appendChild(this.box);

        this.input.value = value;
        this.input.focus();

        // match CSSModule.getEditorOptionKey
        var command = Firebug.chrome.$("cmd_togglecssEditMode");
        command.setAttribute("checked", true);
    },

    hide: function()
    {
        var command = Firebug.chrome.$("cmd_togglecssEditMode");
        command.setAttribute("checked", false);

        if (this.box.parentNode == this.panel.panelNode)
            this.panel.panelNode.removeChild(this.box);

        delete this.target;
        delete this.panel;
        delete this.styleSheet;
    },

    saveEdit: function(target, value, previousValue)
    {
        Firebug.CSSModule.freeEdit(this.styleSheet, value);
    },

    beginEditing: function()
    {
        this.editing = true;
    },

    endEditing: function()
    {
        this.editing = false;
        this.panel.refresh();
        return true;
    },

    // * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * //

    onInput: function()
    {
        Firebug.Editor.update();
    },

    scrollToLine: function(line, offset)
    {
        this.startMeasuring(this.input);
        var lineHeight = this.measureText().height;
        this.stopMeasuring();

        this.input.scrollTop = (line * lineHeight) + offset;
    }
});

Firebug.StyleSheetEditor = StyleSheetEditor;

// ********************************************************************************************* //

Firebug.CSSDirtyListener = function(context)
{
}

Firebug.CSSDirtyListener.isDirty = function(styleSheet, context)
{
    return (styleSheet.fbDirty == true);
}

Firebug.CSSDirtyListener.prototype =
{
    markSheetDirty: function(styleSheet)
    {
        if (!styleSheet && FBTrace.DBG_ERRORS)
        {
            FBTrace.sysout("css; CSSDirtyListener markSheetDirty; styleSheet == NULL");
            return;
        }

        styleSheet.fbDirty = true;

        if (FBTrace.DBG_CSS)
            FBTrace.sysout("CSSDirtyListener markSheetDirty " + styleSheet.href, styleSheet);
    },

    onCSSInsertRule: function(styleSheet, cssText, ruleIndex)
    {
        this.markSheetDirty(styleSheet);
    },

    onCSSDeleteRule: function(styleSheet, ruleIndex)
    {
        this.markSheetDirty(styleSheet);
    },

    onCSSSetProperty: function(style, propName, propValue, propPriority, prevValue,
        prevPriority, rule, baseText)
    {
        var styleSheet = rule.parentStyleSheet;
        this.markSheetDirty(styleSheet);
    },

    onCSSRemoveProperty: function(style, propName, prevValue, prevPriority, rule, baseText)
    {
        var styleSheet = rule.parentStyleSheet;
        this.markSheetDirty(styleSheet);
    }
};

// ********************************************************************************************* //
// Local Helpers

function rgbToHex(value)
{
    return value.replace(/\brgb\((\d{1,3}),\s*(\d{1,3}),\s*(\d{1,3})\)/gi,
        function(_, r, g, b) {
            return '#' + ((1 << 24) + (r << 16) + (g << 8) + (b << 0)).
                toString(16).substr(-6).toUpperCase();
        });
}

function stripUnits(value)
{
    // remove units from '0px', '0em' etc. leave non-zero units in-tact.
    return value.replace(/(url\(.*?\)|[^0]\S*\s*)|0(%|em|ex|px|in|cm|mm|pt|pc)(\s|$)/gi,
        function(_, skip, remove, whitespace) {
            return skip || ('0' + whitespace);
        });
}

function parsePriority(value)
{
    var rePriority = /(.*?)\s*(!important)?$/;
    var m = rePriority.exec(value);
    var propValue = m ? m[1] : "";
    var priority = m && m[2] ? "important" : "";
    return {value: propValue, priority: priority};
}

function parseURLValue(value)
{
    var m = reURL.exec(value);
    return m ? m[1] : "";
}

function parseRepeatValue(value)
{
    var m = reRepeat.exec(value);
    return m ? m[0] : "";
}

function parseCssFontFamilyValue(value, offset)
{
    if (value.charAt(offset) == ",")
        return "";

    var reFonts = /^(.*\d\S*\s)?(.*?)(\s?!important)?$/;
    var m = reFonts.exec(value);
    if (!m)
        return "";

    var fonts = m[2].split(",");
    var fontsLength = fonts.length;
    var totalLength = m[1] ? m[1].length : 0;

    // offset begins at 0
    offset += 1;
    if (m[1] && offset <= m[1].length)
        return "";

    for (var i = 0; i < fontsLength; ++i)
    {
        // +1 because we add the length of ","
        totalLength += fonts[i].length + 1;
        if (totalLength >= offset)
        {
            return {
                value: fonts[i],
                type: "fontFamily"
            };
        }
    }
}

function parseCSSValue(value, offset)
{
    var start = 0;
    var m;
    while (true)
    {
        m = reSplitCSS.exec(value);
        if (m && m.index+m[0].length < offset)
        {
            value = value.substr(m.index+m[0].length);
            start += m.index+m[0].length;
            offset -= m.index+m[0].length;
        }
        else
            break;
    }

    if (!m)
        return;

    var type;
    if (m[1])
        type = "url";
    else if (m[2] || m[4])
        type = "rgb";
    else if (m[3])
        type = "hsl";
    else if (m[5])
        type = "int";

    var cssValue = {value: m[0], start: start+m.index, end: start+m.index+(m[0].length-1), type: type};

    if (!type && m[8] && m[8].indexOf("gradient") != -1)
    {
        var arg = value.substr(m[0].length).match(/\((?:(?:[^\(\)]*)|(?:\(.*?\)))+\)/);
        if (!arg)
            return; 

        cssValue.value += arg[0];
        cssValue.type = "gradient";
    }
    return cssValue;
}

function findPropByName(props, name)
{
    for (var i = 0; i < props.length; ++i)
    {
        if (props[i].name == name)
            return i;
    }
}

function sortProperties(props)
{
    props.sort(function(a, b)
    {
        return a.name > b.name ? 1 : -1;
    });
}

function getRuleLine(rule)
{
    // TODO return closest guess if rule isn't CSSStyleRule
    // and keep track of edited rule lines
    try
    {
        return Dom.domUtils.getRuleLine(rule);
    }
    catch(e)
    {

    }
    return 0;
}

function getTopmostRuleLine(panelNode)
{
    for (var child = panelNode.firstChild; child; child = child.nextSibling)
    {
        if (child.offsetTop+child.offsetHeight > panelNode.scrollTop)
        {
            var rule = child.repObject;
            if (rule)
                return {
                    line: getRuleLine(rule),
                    offset: panelNode.scrollTop-child.offsetTop
                };
        }
    }
    return 0;
}

function getOriginalStyleSheetCSS(sheet, context)
{
    if (sheet.ownerNode instanceof window.HTMLStyleElement)
        return sheet.ownerNode.innerHTML;
    else
        return context.sourceCache.load(sheet.href).join("");
}

function getStyleSheetCSS(sheet, context)
{
    function beutify(css, indent)
    {
        var indent='\n'+Array(indent+1).join(' ');
        var i=css.indexOf('{');
        var match=css.substr(i+1).match(/(?:[^;\(]*(?:\([^\)]*?\))?[^;\(]*)*;?/g);
        match.pop();
        match.pop();
        return css.substring(0, i+1) + indent
                + match.sort().join(indent) + '\n}';
    }
    var cssRules = sheet.cssRules, css=[];
    for(var i = 0; i < cssRules.length; i++)
    {
        var rule = cssRules[i];
        if(rule instanceof window.CSSStyleRule)
            css.push(beutify(rule.cssText, 4));
        else
            css.push(rule.cssText);
    }

    return rgbToHex(css.join('\n\n')) + '\n';
}

function getStyleSheetOwnerNode(sheet)
{
    for (; sheet && !sheet.ownerNode; sheet = sheet.parentStyleSheet);

    return sheet.ownerNode;
}

function scrollSelectionIntoView(panel)
{
    var selCon = getSelectionController(panel);
    selCon.scrollSelectionIntoView(
        nsISelectionController.SELECTION_NORMAL,
        nsISelectionController.SELECTION_FOCUS_REGION, true);
}

function getSelectionController(panel)
{
    var browser = Firebug.chrome.getPanelBrowser(panel);
    return browser.docShell.QueryInterface(nsIInterfaceRequestor)
        .getInterface(nsISelectionDisplay)
        .QueryInterface(nsISelectionController);
}

const reQuotes = /['"]/g;
function getRuleId(rule)
{
    var line = Dom.domUtils.getRuleLine(rule);

    // xxxjjb I hope % is invalid in selectortext
    var ruleId = rule.selectorText.replace(reQuotes,"%")+"/"+line;
    return ruleId;
}

// ********************************************************************************************* //
// Registration

Firebug.registerModule(Firebug.CSSModule);

// xxxHonza: every panel should have its own module/file
Firebug.registerPanel(Firebug.CSSStyleSheetPanel);
Firebug.registerPanel(CSSElementPanel);
Firebug.registerPanel(CSSComputedElementPanel);

return Firebug.CSSModule;

// ********************************************************************************************* //
}});