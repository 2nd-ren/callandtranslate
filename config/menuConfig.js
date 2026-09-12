const contactDialogText =
  "Questions or help: write to info@callandtranslate.com";

function createLeftSection() {
  return {
    id: "homeButton",
    element: "div",
    className: "menuLeft",
    action: { type: "navigate", href: "/app.html" },
    content: [
      {
        type: "text",
        id: "menuLogoText",
        text: "Call & Translate",
      },
    ],
  };
}

function createMenuItem({
  id,
  label,
  action,
  element = "div",
  className = "buttonMenu",
}) {
  return { id, label, action, element, className };
}

const defaultMenu = {
  containerClass: "mainMenu",
  left: createLeftSection(),
  rightElement: "div",
  rightContainerClass: "menuRight",
  right: [
    createMenuItem({
      id: "callsButton",
      label: "Calls",
      action: { type: "navigate", href: "/app.html" },
    }),
    createMenuItem({
      id: "settingsButton",
      label: "Settings",
      action: { type: "openSettings" },
    }),
    createMenuItem({
      id: "aboutButton",
      label: "About",
      action: { type: "navigate", href: "/about.html" },
    }),
    createMenuItem({
      id: "pricingButton",
      label: "Pricing",
      action: { type: "navigate", href: "/pricing.html" },
    }),
    createMenuItem({
      id: "contactButton",
      label: "Contact",
      action: { type: "dialog", dialogText: contactDialogText },
    }),
    createMenuItem({
      id: "logoutButton",
      label: "Logout",
      action: { type: "logout" },
    }),
  ],
};

const adminMenu = {
  ...defaultMenu,
  right: [
    createMenuItem({
      id: "callsButton",
      label: "Calls",
      action: { type: "navigate", href: "/app.html" },
    }),
    createMenuItem({
      id: "settingsButton",
      label: "Settings",
      action: { type: "openSettings" },
    }),
    createMenuItem({
      id: "adminButton",
      label: "Admin",
      action: { type: "navigate", href: "/admin" },
    }),
    createMenuItem({
      id: "aboutButton",
      label: "About",
      action: { type: "navigate", href: "/about.html" },
    }),
    createMenuItem({
      id: "pricingButton",
      label: "Pricing",
      action: { type: "navigate", href: "/pricing.html" },
    }),
    createMenuItem({
      id: "contactButton",
      label: "Contact",
      action: { type: "dialog", dialogText: contactDialogText },
    }),
    createMenuItem({
      id: "logoutButton",
      label: "Logout",
      action: { type: "logout" },
    }),
  ],
};

const menuDefinitions = {
  mainMenu: {
    default: defaultMenu,
    admin: adminMenu,
    roles: {},
  },
};

function cloneMenu(menu) {
  return JSON.parse(JSON.stringify(menu));
}

function getMainMenu({ isAdmin = false, role } = {}) {
  const mainMenuConfig = menuDefinitions.mainMenu || {};
  const { admin, default: defaultMenuDefinition, roles = {} } = mainMenuConfig;

  if (isAdmin && admin) return cloneMenu(admin);
  if (role && roles[role]) return cloneMenu(roles[role]);
  if (defaultMenuDefinition) return cloneMenu(defaultMenuDefinition);

  return {
    containerClass: "mainMenu",
    left: createLeftSection(),
    rightElement: "div",
    rightContainerClass: "menuRight",
    right: [],
  };
}

export { getMainMenu, menuDefinitions };
