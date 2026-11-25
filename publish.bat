@echo off
rem Publishes Pit Wall to GitHub Pages. Grandad's phone picks up the new version next time the app is opened.
cd /d "%~dp0"
title Pit Wall publish
set PY=python
where python >nul 2>nul || set PY=py
rem Give the app a new version stamp so phones know to update
%PY% -c "import re,time;p='sw.js';t=open(p,encoding='utf8').read();t=re.sub(r\"const VERSION = 'pw-[^']*';\",\"const VERSION = 'pw-%%s';\"%%time.strftime('%%Y%%m%%d-%%H%%M%%S'),t);open(p,'w',encoding='utf8',newline='\n').write(t)" || goto fail
git add -A
git diff --cached --quiet && (echo Nothing new to publish. & goto done)
git commit -q -m "Pit Wall update" || goto fail
git push -q || goto fail
echo Published. Grandad's phone will pick it up the next time the app is opened.
:done
pause
exit /b
:fail
echo Something went wrong (see above).
pause
exit /b 1
