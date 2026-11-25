"""Gives sw.js a new version stamp so installed phones fetch the new app files (run by publish.bat)."""
import re, time, os
p = os.path.join(os.path.dirname(os.path.abspath(__file__)), "sw.js")
t = open(p, encoding="utf8").read()
t = re.sub(r"const VERSION = 'pw-[^']*';", "const VERSION = 'pw-%s';" % time.strftime("%Y%m%d-%H%M%S"), t)
open(p, "w", encoding="utf8", newline="\n").write(t)
print("Version stamped.")
