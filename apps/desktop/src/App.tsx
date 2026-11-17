import { isAndroid } from "@/mobileNative/platform";
import { MobileNativeShell } from "@/mobileNative/MobileNativeShell";
import { RavenShellV1 } from "@/shells/RavenShellV1";

export default function App() {
  return isAndroid ? <MobileNativeShell /> : <RavenShellV1 />;
}
