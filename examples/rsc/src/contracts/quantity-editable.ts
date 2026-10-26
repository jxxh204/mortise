import { defineCapability, schema } from '@mortise/core';
export const QuantityEditable = defineCapability({ id: 'quantity-editable', version: 1, state: { quantity: schema.integer(), min: schema.integer(), max: schema.integer() }, commands: { setQuantity: { input: schema.integer(), output: schema.void() } } });
