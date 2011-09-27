/* See license.txt for terms of usage */

define([
    "firebug/lib/object",
    "firebug/firebug",
    "firebug/firefox/firefox",
    "firebug/lib/locale",
    "firebug/lib/domplate",
    "firebug/lib/url",
    "firebug/lib/dom",
],
function(Obj, Firebug, Firefox, Locale, Domplate, Url, Dom) {

// ************************************************************************************************
// Constants

const Cc = Components.classes;
const Ci = Components.interfaces;

const prefs = Cc["@mozilla.org/preferences-service;1"].getService(Ci.nsIPrefBranch2);


/**
 * @module Implements Panel activation logic. A Firebug panel can support activation in order
 * to avoid performance penalties in cases when panel's features are not necessary at the moment.
 * Such panel must be derived from {@link Firebug.ActivablePanel} and appropriate activable
 * module from {@link Firebug.ActivableModule}
 */
Firebug.PanelActivation = Obj.extend(Firebug.Module,
/** @lends Firebug.PanelActivation */
{
    dispatchName: "panelActivation",

    // * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * //

    initialize: function()
    {
        prefs.addObserver(Firebug.Options.getPrefDomain(), this, false);
        Firebug.connection.addListener(this);
    },

    initializeUI: function()
    {
        // The "off" option is removed so make sure to convert previsous prev value
        // into "none" if necessary.
        if (Firebug.allPagesActivation == "off")
            Firebug.allPagesActivation = "none";

        // Update option menu item.
        this.updateAllPagesActivation();
    },

    shutdown: function()
    {
        prefs.removeObserver(Firebug.Options.getPrefDomain(), this, false);
        Firebug.connection.removeListener(this);
    },

    showPanel: function(browser, panel)
    {
        if (FBTrace.DBG_ACTIVATION)
            FBTrace.sysout("PanelActivation.showPanel; " + (panel ? panel.name : "null panel"));

        // Panel toolbar is not displayed for disabled panels.
        var chrome = Firebug.chrome;
        Dom.collapse(chrome.$("fbToolbar"), !panel);
    },

    // * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * //

    activatePanelTypes: function(panelTypes)
    {
        for (var p in panelTypes)
        {
            var panelType = panelTypes[p];
            if (!this.isPanelActivable(panelType))
                continue;

            if (this.isPanelEnabled(panelType))
                panelType.prototype.onActivationChanged(true);
        }
    },

    deactivatePanelTypes: function(panelTypes)
    {
        for (var p in panelTypes)
        {
            var panelType = panelTypes[p];
            if (!this.isPanelActivable(panelType))
                continue;

            if (this.isPanelEnabled(panelType))
                panelType.prototype.onActivationChanged(false);
        }
    },

    // * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * //

    isPanelActivable: function(panelType)
    {
        return panelType.prototype.activable ? true : false;
    },

    isPanelEnabled: function(panelType)
    {
        if (!this.isPanelActivable(panelType))
            return true;

        // Panel "class" object is used to decide whether a panel is disabled
        // or not (i.e.: isEnabled is a static method of Firebug.Panel)
        return panelType ? panelType.prototype.isEnabled() : false;
    },

    // * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * //
    // Enable & disable methods.

    enablePanel: function(panelType)
    {
        this.setPanelState(panelType, true);
    },

    disablePanel: function(panelType)
    {
        this.setPanelState(panelType, false);
    },

    enableAllPanels: function()
    {
        for (var i = 0; i < Firebug.panelTypes.length; ++i)
        {
            var panelType = Firebug.panelTypes[i];
            this.setPanelState(panelType, true);
        }
    },

    disableAllPanels: function()
    {
        for (var i = 0; i < Firebug.panelTypes.length; ++i)
        {
            var panelType = Firebug.panelTypes[i];
            this.setPanelState(panelType, false);
        }
    },

    setPanelState: function(panelType, enable)
    {
        if (panelType && panelType.prototype.setEnabled)
            panelType.prototype.setEnabled(enable);

        this.updateTab(panelType);
    },

    updateTab: function(panelType)
    {
        var panelName = panelType.prototype.name;
        var panelBar = Firebug.chrome.$("fbPanelBar1");
        var tab = panelBar.updateTab(panelType);
    },

    // * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * //
    // Observer activation changes (preference)

    /**
     * Observer for activation preferences changes.
     */
    observe: function(subject, topic, data)
    {
        if (topic != "nsPref:changed")
            return;

        if (data.indexOf(".enableSites") == -1)
            return;

        var parts = data.split(".");
        if (parts.length != 4)
            return;

        try
        {
            var panelName = parts[2];
            var enable = Firebug.Options.get(panelName + ".enableSites");

            var panelType = Firebug.getPanelType(panelName, enable);
            if (panelType)
                this.onActivationChanged(panelType, enable);
        }
        catch (e)
        {
            if (FBTrace.DBG_ACTIVATION || FBTrace.DBG_ERRORS)
                FBTrace.sysout("PanelActivation.observe; EXCEPTION " + e, e);
        }
    },

    onActivationChanged: function(panelType, enable)
    {
        if (!enable)
        {
            // Iterate all contexts and destroy all instances of the specified panel.
            var self = this;
            Firebug.connection.eachContext(function(context) {
                context.destroyPanel(panelType, context.persistedState);
            });
        }

        panelType.prototype.onActivationChanged(enable);

        Firebug.chrome.syncPanel();
    },

    // respond to event
    onClearAnnotations: function()
    {
        Firebug.closeFirebug(true);  // and we turn off as it now cannot be enabled
    },

    // * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * //
    // UI commands

    clearAnnotations: function()
    {
        Firebug.connection.clearAnnotations();
    },

    toggleAll: function(state)
    {
        if (FBTrace.DBG_ACTIVATION)
            FBTrace.sysout("Firebug.toggleAll("+state+") with allPagesActivation: " +
                Firebug.allPagesActivation);

        if (state == "on")
        {
            if (Firebug.allPagesActivation == state) // then we were armed
                Firebug.allPagesActivation = "none";
            else
                this.allOn();
        }
        else
        {
            Firebug.allPagesActivation = "none";
        }

        Firebug.Options.set("allPagesActivation", Firebug.allPagesActivation);
        this.updateAllPagesActivation();
    },

    updateOption: function(name, value)
    {
        if (name == "allPagesActivation")
            this.updateAllPagesActivation();
    },

    updateAllPagesActivation: function()
    {
        var allOn = Firebug.allPagesActivation == "on";

        var menu = Firefox.getElementById('menu_AllOn');
        if (menu)
            menu.setAttribute("checked", allOn);

        // don't show Off button if we are always on
        Firebug.chrome.disableOff(allOn);

        Firebug.StartButton.resetTooltip();
    },

    allOn: function()
    {
        Firebug.allPagesActivation = "on";  // In future we always create contexts,
        Firebug.toggleBar(true);  // and we turn on for the current page
    }
});

// ************************************************************************************************

/**
 * @domplate This template renders default content for disabled panels.
 */
with (Domplate) {
Firebug.DisabledPanelBox = domplate(Firebug.Rep,
/** @lends Firebug.DisabledPanelBox */
{
    tag:
        DIV({"class": "disabledPanelBox"},
            H1({"class": "disabledPanelHead"},
                SPAN("$pageTitle")
            ),
            P({"class": "disabledPanelDescription", style: "margin-top: 15px;"},
                Locale.$STR("moduleManager.desc3"),
                SPAN("&nbsp;"),
                SPAN({"class": "descImage descImage-$panelName"})
            ),
            A({"class": "objectLink", onclick: "$onEnable"},
                Locale.$STR("moduleManager.Enable")
            )
            /* need something here that pushes down any thing appended to the panel */
        ),

    onEnable: function(event)
    {
        var view = event.target.ownerDocument.defaultView;
        var isMainPanel = (view.name == "fbPanelBar1-browser");
        var panelBar = Firebug.chrome.$(isMainPanel ? "fbPanelBar1" : "fbPanelBar2");

        var panelType = panelBar.selectedTab.panelType;
        if (panelType.prototype.setEnabled)
        {
            panelType.prototype.setEnabled(true);
            panelBar.updateTab(panelType);
        }
        else
        {
            if (FBTrace.DBG_ERRORS)
                FBTrace.sysout("panelActivation.onEnable; panel is not activable: " +
                    Firebug.getPanelTitle(panelType));
        }
    },

    /**
     * Show default content saying that this panel type (specified by name) is disabled.
     * The parent node is specified in panel.html file.
     */
    show: function(browser, panelName)
    {
        if (!panelName)
            return;

        var panel = Firebug.getPanelType(panelName);
        var panelTitle = Firebug.getPanelTitle(panel);
        var args = {
            pageTitle: Locale.$STRF("moduleManager.title", [panelTitle]),
            panelName: panelName
        };

        var parentNode = this.getParentNode(browser);
        this.tag.replace(args, parentNode, this);
        parentNode.removeAttribute("collapsed");
    },

    /**
     * Hide currently displayed default content.
     */
    hide: function(browser)
    {
        var parentNode = this.getParentNode(browser);
        Dom.clearNode(parentNode);
        parentNode.setAttribute("collapsed", true);
    },

    getParentNode: function(browser)
    {
        var doc = browser.contentDocument;
        return doc.documentElement.querySelector(".disabledPanelNode");
    },
})};

// ************************************************************************************************
// Registration

Firebug.registerModule(Firebug.PanelActivation);

return Firebug.PanelActivation;

// ************************************************************************************************
});
