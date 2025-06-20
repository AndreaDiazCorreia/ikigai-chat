import { generateResponse } from '../ai/openai.js'
import { logger } from '../logger/index.js'
import { getAvailableTags, findSimilarNotes } from './notion.js'


export interface Note {
    titulo: string
    contenido: string
    etiquetas: string[]
}


export interface SaveNoteIntent {
    type: 'save_note'
    titulo: string
    contenido: string
    etiquetas: string[] 
    confidence: number
    suggested_tags?: string[] 
}

export interface QueryIntent {
    type: 'query'
    queryType: 'by_tag' | 'by_keyword' | 'count' | 'recent'
    parameter?: string
    confidence: number
}

export interface ConversationIntent {
    type: 'conversation'
    response: string
    confidence: number
}

export interface UnclearIntent {
    type: 'unclear'
    clarificationQuestion: string
}

export interface TagCorrectionIntent {
    type: 'tag_correction'
    noteId: string
    newTags: string[]
    originalNote: string
}

export type IntentResult = SaveNoteIntent | QueryIntent | ConversationIntent | UnclearIntent | TagCorrectionIntent


async function generateClassificationPrompt(): Promise<string> {
    const availableTags = await getAvailableTags()
    const tagsString = availableTags.length > 0 ? availableTags.map(tag => `"${tag}"`).join(', ') : '"Otros"'
    
    return `
Eres Ikigai, un asistente inteligente para gestión de notas via WhatsApp. Tu tarea es analizar cada mensaje y clasificar la intención del usuario.

TIPOS DE INTENCIÓN:

1. **GUARDAR NOTA** - El usuario quiere guardar información
   - Recetas (ingredientes, pasos, cocina)
   - Links útiles (URLs, artículos, recursos)
   - Ideas (pensamientos, conceptos, inspiración)
   - Eventos (fechas, reuniones, actividades)
   - Otros (cualquier información que quiera recordar)

2. **CONSULTAR** - El usuario quiere buscar información guardada
   - "¿Qué recetas tengo?"
   - "Muéstrame mis notas de esta semana"
   - "Busca algo sobre proyectos"
   - "¿Cuántas notas tengo?"

3. **CONVERSACIÓN** - Saludos, agradecimientos, charla casual
   - "Hola", "Gracias", "¿Cómo estás?"

4. **NO CLARO** - Mensaje ambiguo que necesita clarificación

5. **CORRECCIÓN DE ETIQUETAS** - El usuario quiere cambiar etiquetas de una nota
   - "Cambia la etiqueta de X a Y"
   - "Esa nota debería ser de tipo Z"

ETIQUETAS DISPONIBLES: "${tagsString}"

IMPORTANTE PARA ETIQUETADO:
- Puedes asignar MÚLTIPLES etiquetas si es apropiado (máximo 3)
- Usa EXACTAMENTE las etiquetas disponibles cuando sea posible
- Si ninguna etiqueta encaja perfectamente, usa "Otros"
- Para contenido que abarca múltiples categorías, asigna varias etiquetas relevantes
- Prioriza siempre las etiquetas existentes sobre crear nuevas

IMPORTANTE PARA CONTENIDO:
- Si el mensaje contiene una URL, SIEMPRE inclúyela en el contenido
- Si hay texto descriptivo Y URL, incluye AMBOS en el contenido
- El contenido debe ser completo y útil para futuras búsquedas
- Para URLs de YouTube, extrae el título si es posible, pero SIEMPRE incluye la URL

CRITERIOS PARA MÚLTIPLES ETIQUETAS:
- Una receta compartida como idea → ["Recetas", "Ideas"]
- Un link sobre eventos → ["Links útiles", "Evento"]
- Una nota de trabajo que es también una idea → ["Otros", "Ideas"]

INSTRUCCIONES:
- Responde SOLO con un JSON válido
- Para notas: extrae título descriptivo, contenido estructurado CON URLs incluidas, y etiquetas apropiadas (array)
- Para consultas: identifica qué tipo de búsqueda quiere hacer
- Para conversación: genera respuesta natural y amigable
- Para mensajes ambiguos: formula pregunta clarificadora

EJEMPLOS DE RESPUESTA:

Para nota con URL:
{
  "type": "save_note",
  "titulo": "Tutorial de programación en 33 minutos",
  "contenido": "Vibe Coding Fundamentals In 33 minutes - Tutorial completo de programación. URL: https://youtu.be/ejemplo123",
  "etiquetas": ["Links útiles"],
  "confidence": 0.9
}

Para nota con múltiples etiquetas:
{
  "type": "save_note",
  "titulo": "Receta de pasta italiana para evento",
  "contenido": "Pasta con tomate, albahaca y mozzarella para 10 personas",
  "etiquetas": ["Recetas", "Evento"],
  "confidence": 0.9
}

Para consulta específica:
{
  "type": "query", 
  "queryType": "by_keyword",
  "parameter": "arepas",
  "confidence": 0.85
}

Para conversación:
{
  "type": "conversation",
  "response": "¡Hola! Soy Ikigai, tu asistente para organizar notas. ¿En qué puedo ayudarte hoy?",
  "confidence": 0.95
}

Para mensaje ambiguo:
{
  "type": "unclear",
  "clarificationQuestion": "¿Quieres que guarde esto como una nota? ¿De qué tipo sería: receta, idea, evento u otro?"
}

Analiza este mensaje del usuario:`
}


async function suggestTagsFromSimilarContent(content: string): Promise<string[]> {
    try {
        const similarNotes = await findSimilarNotes(content)
        if (similarNotes.length === 0) return []

        
        const tagCounts: Record<string, number> = {}
        
        similarNotes.slice(0, 5).forEach(note => { 
            
            if (note.etiquetas && Array.isArray(note.etiquetas)) {
                note.etiquetas.forEach(tag => {
                    tagCounts[tag] = (tagCounts[tag] || 0) + 1
                })
            } 
            
            const legacyNote = note as any
            if (legacyNote.etiqueta && typeof legacyNote.etiqueta === 'string') {
                tagCounts[legacyNote.etiqueta] = (tagCounts[legacyNote.etiqueta] || 0) + 1
            }
        })

        
        return Object.entries(tagCounts)
            .filter(([_, count]) => count >= 2)
            .sort(([_, a], [__, b]) => b - a)
            .slice(0, 3)
            .map(([tag, _]) => tag)
            
    } catch (error) {
        logger.error('Error suggesting tags from similar content:', error)
        return []
    }
}

export async function classifyIntent(userMessage: string): Promise<IntentResult> {
    try {
        
        const dynamicPrompt = await generateClassificationPrompt()
        const fullPrompt = `${dynamicPrompt}\n\nMensaje: "${userMessage}"`
        
        const response = await generateResponse(fullPrompt)
        
        
        let result: IntentResult
        try {
            result = JSON.parse(response)
        } catch (parseError) {
            logger.warn('Error parsing classification response, falling back to conversation', { response })
            return {
                type: 'conversation',
                response: 'Disculpa, no entendí bien tu mensaje. ¿Podrías reformularlo?',
                confidence: 0.3
            }
        }

        
        if (result.type === 'save_note') {
            const saveNoteResult = result as SaveNoteIntent
            const suggestedTags = await suggestTagsFromSimilarContent(saveNoteResult.contenido)
            
            if (suggestedTags.length > 0) {
                saveNoteResult.suggested_tags = suggestedTags
                logger.info('Tags suggested based on similar content', { 
                    originalTags: saveNoteResult.etiquetas,
                    suggestedTags 
                })
            }
        }

        logger.info('Intent classified successfully', { 
            type: result.type, 
            confidence: 'confidence' in result ? result.confidence : 'N/A'
        })
        
        return result

    } catch (error) {
        logger.error('Error classifying intent:', error)
        return {
            type: 'conversation',
            response: 'Disculpa, tuve un problema procesando tu mensaje. ¿Puedes intentar de nuevo?',
            confidence: 0.1
        }
    }
}


export function isHighConfidence(intent: IntentResult): boolean {
    if ('confidence' in intent) {
        return intent.confidence > 0.7
    }
    return false
}


export function formatQueryResponse(notes: any[], queryType: string, parameter?: string): string {
    if (notes.length === 0) {
        if (parameter) {
            return `❌ No encontré notas que contengan exactamente "${parameter}".\n\n💡 Puedes intentar con:\n• Términos más generales\n• Sinónimos\n• Palabras clave específicas\n\n¿Quieres que busque algo relacionado?`
        }
        return 'No tienes notas guardadas aún. ¡Envíame algo para empezar!'
    }

    let response = ''
    
    
    const firstResult = notes[0]
    const isExactMatch = firstResult.relevancia && firstResult.relevancia >= 10
    const isSynonymMatch = firstResult.relevancia && firstResult.relevancia >= 3 && firstResult.relevancia < 10
    const isFuzzyMatch = firstResult.relevancia && firstResult.relevancia < 3
    
    switch (queryType) {
        case 'by_tag':
            response = `📝 Tienes ${notes.length} nota${notes.length > 1 ? 's' : ''} en "${parameter}":\n\n`
            break
        case 'by_keyword':
            if (isExactMatch) {
                response = `🎯 Encontré ${notes.length} nota${notes.length > 1 ? 's' : ''} que contiene${notes.length > 1 ? 'n' : ''} "${parameter}":\n\n`
            } else if (isSynonymMatch) {
                response = `✨ Encontré ${notes.length} nota${notes.length > 1 ? 's' : ''} relacionada${notes.length > 1 ? 's' : ''} con "${parameter}":\n\n`
            } else if (isFuzzyMatch) {
                response = `💡 No encontré coincidencias exactas para "${parameter}", pero estas notas podrían interesarte:\n\n`
            } else {
                response = `🔍 Encontré ${notes.length} nota${notes.length > 1 ? 's' : ''} sobre "${parameter}":\n\n`
            }
            break
        case 'recent':
            response = `📅 Tus notas más recientes:\n\n`
            break
        case 'count':
            response = `📊 Tienes un total de ${notes.length} notas:\n\n`
            break
        default:
            response = `📋 Encontré ${notes.length} nota${notes.length > 1 ? 's' : ''}:\n\n`
    }

    
    const limitedNotes = notes.slice(0, 5)
    
    limitedNotes.forEach((note, index) => {
        
        const contenido = note.contenido || ''
        const shortContent = contenido.length > 80 
            ? contenido.substring(0, 80) + '...'
            : contenido
        
        response += `${index + 1}. **${note.titulo}**\n`
        response += `   ${shortContent}\n`
        
        
        if (note.etiquetas && Array.isArray(note.etiquetas)) {
            response += `   🏷️ ${note.etiquetas.join(', ')}\n`
        } else if (note.etiqueta) {
            response += `   🏷️ ${note.etiqueta}\n`
        }
        
        
        if (note.relevancia && note.relevancia > 0) {
            if (note.relevancia >= 10) {
                response += `   🎯 Coincidencia exacta`
            } else if (note.relevancia >= 3) {
                response += `   ✨ Relacionado`
            } else {
                response += `   💡 Sugerencia`
            }
            
            if (note.coincidencias && note.coincidencias.length > 0) {
                response += ` - ${note.coincidencias[0]}`
            }
            response += `\n`
        }
        
        response += `\n`
    })

    if (notes.length > 5) {
        response += `... y ${notes.length - 5} nota${notes.length - 5 > 1 ? 's' : ''} más.\n\n`
    }

    
    if (queryType === 'by_keyword') {
        if (isExactMatch) {
            response += `✅ *Estas son coincidencias exactas para "${parameter}"*`
        } else if (isSynonymMatch) {
            response += `💡 *Tip: Estas notas están relacionadas con "${parameter}". Puedes buscar términos más específicos para mejores resultados.*`
        } else if (isFuzzyMatch) {
            response += `🔍 *Tip: No hay coincidencias exactas. Prueba con sinónimos o términos más específicos.*`
        }
        
        if (notes.length > 0) {
            response += `\n\n¿Quieres ver detalles de alguna nota específica?`
        }
    }

    return response
}


export function parseTagCorrection(message: string, noteContext?: string): TagCorrectionIntent | null {
    
    const patterns = [
        /cambia.*etiqueta.*a\s+(.+)/i,
        /debería ser\s+(.+)/i,
        /etiqueta.*(.+)/i,
        /categoría.*(.+)/i
    ]

    for (const pattern of patterns) {
        const match = message.match(pattern)
        if (match) {
            const newTagsText = match[1].trim()
           
            const newTags = newTagsText.split(/,|\s+y\s+/).map(tag => tag.trim()).filter(tag => tag.length > 0)
            
            return {
                type: 'tag_correction',
                noteId: '', 
                newTags,
                originalNote: noteContext || message
            }
        }
    }

    return null
}