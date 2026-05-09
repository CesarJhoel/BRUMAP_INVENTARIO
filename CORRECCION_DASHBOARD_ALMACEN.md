# Corrección Dashboard + Almacén

Cambios aplicados:

- Se corrigió la inicialización del panel para que no dependa de una ruta exacta como `/panel.html`.
- Las pestañas internas de Almacén ahora usan delegación de eventos y se inicializan aunque el script cargue después del DOM.
- Se agregó carga inicial automática de la pestaña activa de Almacén.
- Se conectó cada pestaña con sus datos: Materiales, Kardex, Conteo físico, Proveedores, Clientes, Productos terminados, Órdenes y Envíos terminados.
- Se actualiza el dashboard global después de registrar materiales, movimientos, conteos, producción, órdenes y envíos.
- Se corrigieron IDs del dashboard: `kpiRecepciones` y `chartRecepciones` ahora coinciden con el HTML actual.
- El dashboard ahora consolida información de los apartados principales: materiales, kardex, conteos, proveedores, clientes, productos terminados, órdenes, envíos, defectuosos, maquinaria y repuestos.
- Si Chart.js no carga, el dashboard ya no queda intentando indefinidamente: muestra KPIs, resumen y mensajes en los gráficos.
- Se agregó resumen visual por apartado en el dashboard.
