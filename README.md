# DTWIG — Digital Twin for What-If in Greenhouses

What-if explorer for the digital twin of the Osiris experimental greenhouse
(University of Murcia). The browser runs the 15-min and 1-h one-step models
over the blocks of the August 2026 randomised campaign. There is no backend;
serving this folder is enough.

    index.html  style.css  app.js  twin_data.json

## Regenerating the data

    python3 paper/PaperB/presentacion/twin_export.py   # from the repository root

## Running locally

    cd paper/PaperB/presentacion/web && python3 -m http.server 8000
    # http://localhost:8000

Opening `index.html` directly (file://) does not work: the browser blocks
loading `twin_data.json`.

## Deploying

Copy the folder to any static server (nginx, Apache, GitHub Pages…):

    rsync -av paper/PaperB/presentacion/web/ user@server:/var/www/dtwig/

`twin_data.json` is about 3 MB and compresses to 1 MB, so enable gzip for
JSON. With nginx:

    location /dtwig/ {
        alias /var/www/dtwig/;
        gzip on;
        gzip_types application/json application/javascript text/css;
    }

Fonts come from Google Fonts; without access to them the page falls back to
system fonts.
