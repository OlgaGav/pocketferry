'use strict';
// Gives the dashboard one ability the browser lacks: the real path of a file
// dragged into the window, so it can be offered to the phone without copying it.
const { contextBridge, webUtils } = require('electron');

contextBridge.exposeInMainWorld('pocketferry', {
  pathFor: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return '';
    }
  },
});
