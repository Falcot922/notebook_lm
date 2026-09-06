#!/bin/bash
# Ouvre l'application via un serveur local (solution de secours si le
# double-clic sur le fichier HTML pose problème).
cd "$(dirname "$0")"
(sleep 1 && open "http://localhost:8777/Notes%20au%20propre.html") &
python3 -m http.server 8777
