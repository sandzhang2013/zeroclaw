// Eager page modules. Vite + Chrome cache a failed `import()` for the whole
// document lifetime, so a transient transform error (HMR mid-edit) made
// Config / Agents / SOPs stay broken until a hard refresh. Static imports
// keep those routes on the main graph.

export { default as Dashboard } from '../pages/Dashboard';
export { default as AgentChat } from '../pages/AgentChat';
export { default as WorkbenchPage } from '../pages/WorkbenchPage';
export { default as AgentsList } from '../pages/AgentsList';
export { default as AgentWorkspaceExplorer } from '../pages/AgentWorkspaceExplorer';
export { default as Tools } from '../pages/Tools';
export { default as Cron } from '../pages/Cron';
export { default as Integrations } from '../pages/Integrations';
export { default as Config } from '../pages/Config';
export { default as Logs } from '../pages/Logs';
export { default as Doctor } from '../pages/Doctor';
export { default as Pairing } from '../pages/Pairing';
export { default as Canvas } from '../pages/Canvas';
export { default as AcpConsole } from '../pages/AcpConsole';
export { default as Quickstart } from '../pages/quickstart/Quickstart';
export { default as Skills } from '../pages/Skills';
export { SopsList, SopView, SopEditor } from '../pages/Sops';
export { default as Runs } from '../pages/Runs';
export { default as RunDetail } from '../pages/RunDetail';
