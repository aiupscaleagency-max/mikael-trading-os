import {EventEmitter} from 'node:events';
import type {IgEnvironment} from './igConnection.js';
export const igEvents=new EventEmitter();
export function igChanged(environment:IgEnvironment){igEvents.emit('changed',environment);}
