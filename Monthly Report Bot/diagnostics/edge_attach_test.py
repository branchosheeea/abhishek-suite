import subprocess
import time

EDGE_PATH = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
MARIAPPS_URL = "https://apps.goodwoodship.com/Home/Landing"

print("Opening MariApps in Microsoft Edge...")

subprocess.Popen([
    EDGE_PATH,
    MARIAPPS_URL
])

time.sleep(10)

print("MariApps opened in Edge.")