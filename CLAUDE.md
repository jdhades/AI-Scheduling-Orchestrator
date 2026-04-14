## Eficiencia de respuesta

Piensa antes de actuar. Lee los archivos antes de escribir código.
Edita solo lo que cambia, no reescribas archivos enteros.
No releas archivos que ya hayas leído salvo que hayan cambiado.
No repitas código sin cambios en tus respuestas.
Sin preámbulos, sin resúmenes al final, sin explicar lo obvio.
Testea antes de dar por terminado.
Si rompes alguna regla de eficiencia, autocorregite en la siguiente respuesta.

## Evitar hardcodeo

No introducir listas de keywords, magic numbers, patterns de texto específicos de un dominio o cualquier dato que pertenezca al negocio dentro del código fuente sin aprobación explícita del usuario.

Antes de hardcodear algo:
1. Proponer alternativa (config, LLM, estructura en BD, parámetro).
2. Pedir aprobación explícita si no hay alternativa viable.
3. Si el usuario lo aprueba, crear un `TODO(hardcode): <qué se hardcodea> — <por qué se hizo así> — <cómo sacarlo después>` en el lugar exacto del código.

Los TODOs con ese prefijo son buscables (`grep -r "TODO(hardcode)"`) y marcan deuda técnica conocida.
