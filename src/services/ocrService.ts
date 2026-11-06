export interface OcrResult {
  text: string;
  confidence: number;
}

/**
 * Ejecuta OCR 100% en el navegador del cliente usando Tesseract.js (WebAssembly)
 * con paquete de idioma español ('spa').
 * Carga el motor bajo demanda (dynamic import) solo cuando el usuario sube una captura.
 */
export async function runBrowserOcr(
  imageFile: File,
  onProgress?: (progressPct: number) => void
): Promise<OcrResult> {
  const { createWorker } = await import('tesseract.js');
  const worker = await createWorker('spa', 1, {
    logger: (m) => {
      if (m.status === 'recognizing text' && typeof m.progress === 'number' && onProgress) {
        onProgress(Math.round(m.progress * 100));
      }
    },
  });

  try {
    const { data } = await worker.recognize(imageFile);
    return {
      text: data.text.trim(),
      confidence: Math.round(data.confidence),
    };
  } finally {
    await worker.terminate();
  }
}
