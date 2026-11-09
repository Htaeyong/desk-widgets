// Whether a quit may go on (#129). A person quitting can be asked first by a running widget. A quit the engine itself starts to
// let its installer replace it is never asked: nobody may be there to answer, and the installer is waiting.
// The other ways an engine ends never reach this: Windows shutdown or logout does not emit before-quit (Electron docs), and an
// installer's taskkill closes windows or ends the process without it.
function createQuitGate(ask) {
  let unattended = false;
  return {
    /** From here on, a quit is not asked. */
    unattended() {
      unattended = true;
    },
    allows: () => unattended || ask(),
  };
}

module.exports = { createQuitGate };
