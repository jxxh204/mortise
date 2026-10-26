import { defineAction, schema } from '@mortise/core';
import { MortiseHttpError } from '@mortise/server';
export default defineAction({ input: schema.integer(), async run(next, ctx) {
        if (next < ctx.root.minimumGuests || next > ctx.root.maximumGuests)
            throw new MortiseHttpError(422, 'GUEST_LIMIT', '예약 인원은 1~6명이어야 합니다.');
        await ctx.services.booking.setGuests(next);
    } });
