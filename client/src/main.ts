import "./style.css";
import { AppView } from "./ui/AppView";

const root = document.getElementById("app");
if (!root) throw new Error("Missing #app");
new AppView(root);
