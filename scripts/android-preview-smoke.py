"""Exercise the installed GetOpenPrism preview on a fresh Android test emulator."""
import os
from pathlib import Path
import re
import subprocess
import time
from xml.etree import ElementTree

PACKAGE = "com.getopenprism.app"
OUTPUT = Path(os.environ["ANDROID_TEST_OUTPUT"])


def adb(*args, timeout=30):
    return subprocess.check_output(["adb", *args], timeout=timeout)


def capture(name):
    (OUTPUT / name).write_bytes(adb("exec-out", "screencap", "-p"))


def chat_link(timeout):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            adb("shell", "uiautomator", "dump", "/sdcard/prism-ui.xml", timeout=8)
            root = ElementTree.fromstring(adb("shell", "cat", "/sdcard/prism-ui.xml"))
            for node in root.iter("node"):
                props = node.attrib
                if props.get("package") != PACKAGE:
                    continue
                if "Open web chat" not in (props.get("text"), props.get("content-desc")):
                    continue
                x1, y1, x2, y2 = map(int, re.findall(r"\d+", props["bounds"]))
                return (x1 + x2) // 2, (y1 + y2) // 2
        except (subprocess.SubprocessError, ElementTree.ParseError):
            pass
        time.sleep(1)
    raise RuntimeError("The GetOpenPrism chat link never appeared")


def main():
    OUTPUT.mkdir(parents=True, exist_ok=True)
    adb("install", "-r", os.environ["ANDROID_TEST_APK"], timeout=120)
    activity = adb("shell", "cmd", "package", "resolve-activity", "--brief", PACKAGE).decode().strip().splitlines()[-1]
    if not activity.startswith(PACKAGE + "/"):
        raise RuntimeError(f"No launcher activity resolved for {PACKAGE}")
    adb("logcat", "-c")
    try:
        adb("shell", "am", "start", "-W", "-n", activity)
        x, y = chat_link(75)
        capture("01-native-home.png")
        adb("shell", "input", "tap", str(x), str(y))
        for _ in range(30):
            events = adb("logcat", "-b", "system", "-d", "-s", "ActivityTaskManager:I").decode(errors="replace")
            if any("android.intent.action.VIEW" in line and "https://getopenprism.com" in line for line in events.splitlines()):
                break
            time.sleep(1)
        else:
            raise RuntimeError("Tapping the chat link did not dispatch the GetOpenPrism URL")
        capture("02-open-web-chat.png")
        for _ in range(3):
            adb("shell", "input", "keyevent", "KEYCODE_BACK")
            try:
                chat_link(8)
                break
            except RuntimeError:
                continue
        else:
            raise RuntimeError("Android Back did not return to the GetOpenPrism home screen")
        capture("03-returned-to-app.png")
        print("PASS: native launch, Open web chat, Android Back")
    finally:
        crash = adb("logcat", "-b", "crash", "-d").decode(errors="replace")
        (OUTPUT / "crash-log.txt").write_text(crash, encoding="utf-8")
        js_errors = adb("logcat", "-d", "-s", "ReactNativeJS:E", "AndroidRuntime:E")
        (OUTPUT / "runtime-errors.txt").write_bytes(js_errors)
        capture("last-screen.png")
    if PACKAGE in crash:
        raise RuntimeError("GetOpenPrism appeared in the Android crash buffer")


if __name__ == "__main__":
    main()
