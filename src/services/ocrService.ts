import { createWorker } from 'tesseract.js';

export interface OcrResult {
  text: string;
  confidence: number;
}

/**
 * Ejecuta OCR 100% en el navegador del cliente usando Tesseract.js (WebAssembly)
 * con paquete de idioma español ('spa').
 * Si falla o no puede inicializar, lanza un error controlado para degradar a carga manual.
 */
export async function runBrowserOcr(
  imageFile: File,
  onProgress?: (progressPct: number) => void
): Promise<OcrResult> {
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
