# Dibujante de Inmoescala

Este repositorio existe **solo** para sacar imágenes y videos para Work, la herramienta interna de Inmoescala:

- **dibujar-club.mjs**: convierte una pieza de Inmoescala Club (carrusel, historias y portada en video) en archivos PNG y MP4.
- **capturar.mjs**: saca capturas de pantalla de las cuentas demo de Connect y Office, sin tocar nada en ellas.

Es público porque GitHub no cobra minutos de Actions en repositorios públicos.

## Lo que este repositorio NO tiene

- Ninguna llave, contraseña ni dato de clientes. El único secreto (`CAPTURER_SECRET`) vive en los *secrets* de GitHub y nunca aparece en el código ni en los registros.
- Contenido de las piezas: el runner lo pide a Work en cada ejecución y Work lo entrega solo con el secreto.

## Cómo corre

Work lanza los workflows con `workflow_dispatch` (solo el dueño del repo puede lanzarlos). El runner pide a Work lo que tiene que dibujar, saca los archivos y se los devuelve a Work. No hay otra forma de lanzarlos: ni push ni pull requests.
