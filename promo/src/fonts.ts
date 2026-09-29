import { loadFont as loadGeist } from '@remotion/google-fonts/Geist';
import { loadFont as loadMono } from '@remotion/google-fonts/JetBrainsMono';

export const sans = loadGeist('normal', { weights: ['400', '500', '600', '700'], subsets: ['latin'] }).fontFamily;
export const mono = loadMono('normal', { weights: ['400', '700'], subsets: ['latin'] }).fontFamily;
