# DTWIG — Digital Twin for What-If in Greenhouses

Web del gemelo digital del invernadero Osiris (UMU).

Web estática del gemelo digital del Paper B: simula en el navegador los modelos
de 15 min y de 1 h sobre los bloques de la campaña de agosto. No necesita
backend; basta con servir esta carpeta.

    index.html  style.css  app.js  twin_data.json

## Regenerar los datos

    python3 paper/PaperB/presentacion/twin_export.py   # desde la raíz del repo

## Probar en local

    cd paper/PaperB/presentacion/greenhouseDT && python3 -m http.server 8000
    # http://localhost:8000

Abrir `index.html` con doble clic (file://) no funciona: el navegador bloquea la
carga de `twin_data.json`.

## Desplegar

Copia la carpeta a cualquier servidor estático (nginx, Apache, GitHub Pages…):

    rsync -av paper/PaperB/presentacion/greenhouseDT/ usuario@servidor:/var/www/dtwig/

`twin_data.json` pesa unos 3 MB y comprime a 1 MB: activa gzip para
JSON. En nginx:

    location /dtwig/ {
        alias /var/www/dtwig/;
        gzip on;
        gzip_types application/json application/javascript text/css;
    }

Las tipografías vienen de Google Fonts; sin conexión a ellas la página usa las
del sistema.
