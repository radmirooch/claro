// Ollama and Claro stream newline-delimited JSON. Decode across UTF-8 and
// network chunk boundaries; an HTTP chunk is not necessarily a JSON record.
export async function readJSONLines(body, onEvent) {
  if (!body?.getReader)
    throw new Error('Поток перевода недоступен.');
  const reader = body.getReader(),
    decoder = new TextDecoder();
  let buffer = '';
  const emit = line => {
    if (line.trim())
      onEvent(JSON.parse(line));
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      if (buffer.length > 1000000)
        throw new Error('Слишком большой ответ переводчика.');
      let newline;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        emit(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
      }
      if (done) {
        emit(buffer);
        return;
      }
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}
