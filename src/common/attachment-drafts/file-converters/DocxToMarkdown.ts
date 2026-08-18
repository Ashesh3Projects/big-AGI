import { convertToHtml, images } from 'mammoth';


export async function convertDocxToHTML(input: ArrayBuffer): Promise<{ html: string }> {
  try {
    const mammothInput = typeof window === 'undefined'
      ? { buffer: Buffer.from(input) }
      : { arrayBuffer: input };
    const result = await convertToHtml(mammothInput, {
      convertImage: images.imgElement(function ignoreImage(image) {
        throw new Error('Images are not supported in DOCX to Markdown conversion');
      }),
    });
    if (result.messages?.length) {
      console.log('Messages from DOCX to Markdown conversion:', result.messages);
    }
    return {
      html: result.value,
    };
  } catch (error) {
    console.error('Error converting DOCX to Markdown:', error);
    throw error;
  }
}
