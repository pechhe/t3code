// Stands in for `electron` under Vitest. The real package downloads its binary when it is
// imported without one, so test processes that import it together extract the same archive
// over each other and fail with "Electron failed to install correctly". Outside Electron the
// real module is only the executable's path, so a path is all a test needs from it.
export default "electron";
