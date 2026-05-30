import { app, BrowserWindow, ipcMain } from "electron";
import { join } from "path";
import { ensureDaemon, killDaemon } from "./daemon-bridge";
import * as tabManager from "./tab-manager";

let mainWindow: BrowserWindow | null = null;
let daemonPort: number | null = null;

const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    try {
      daemonPort = await ensureDaemon();
    } catch (err) {
      console.error("Failed to start daemon:", err);
      app.quit();
      return;
    }

    createWindow();
  });
}

// IPC: renderer asks for daemon port
ipcMain.handle("get-daemon-port", () => daemonPort);

// IPC: renderer requests new tab
ipcMain.handle("create-tab", (_event, sandboxId: string, kind: string, title: string) => {
  if (!daemonPort) throw new Error("Daemon not running");
  tabManager.createTab(sandboxId, kind as "cli" | "app", title, daemonPort);
});

// IPC: renderer requests tab switch
ipcMain.handle("switch-tab", (_event, sandboxId: string) => {
  tabManager.switchToTab(sandboxId);
});

// IPC: renderer requests tab close
ipcMain.handle("close-tab", (_event, sandboxId: string) => {
  tabManager.closeTab(sandboxId);
});

// IPC: list tabs
ipcMain.handle("list-tabs", () => {
  return tabManager.getAllTabs().map((t) => ({
    id: t.id,
    kind: t.kind,
    title: t.title,
  }));
});

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    title: "System Test Sandbox",
    titleBarStyle: "hiddenInset",
    show: false,
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  tabManager.setMainWindow(mainWindow);

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }

  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    killDaemon();
    app.quit();
  }
});

app.on("before-quit", () => {
  killDaemon();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0 && daemonPort) {
    createWindow();
  }
});
