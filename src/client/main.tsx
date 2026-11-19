import { createRoot } from "react-dom/client";
import { VmHome } from "./vm-home.tsx";
import "./style.css";

const root = createRoot(document.getElementById("root")!);
root.render(<VmHome />);
if (import.meta.hot) import.meta.hot.dispose(() => root.unmount());
