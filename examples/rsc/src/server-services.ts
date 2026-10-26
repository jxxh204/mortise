// SERVER-ONLY memory repository. Restarting Node clears demo data.
const SERVER_ONLY_SENTINEL = 'MORTISE_PRIVATE_REPOSITORY_V02';
void SERVER_ONLY_SENTINEL;
const carts = new Map<string, {
    id: string;
    name: string;
    price: number;
    quantity: number;
    min: number;
    max: number;
}[]>();
let guests = 2;
const pause = () => new Promise<void>(r => setTimeout(r, 100));
function cartItems(id: string) {
    if (!['cart-main', 'cart-other'].includes(id))
        throw new Error('Unknown demo cart');
    if (!carts.has(id))
        carts.set(id, [{ id: 'keyboard', name: '키보드', price: 50000, quantity: 1, min: 1, max: 10 }, { id: 'mouse', name: '마우스', price: 20000, quantity: 1, min: 1, max: 10 }]);
    return carts.get(id)!;
}
export const services = {
    cart: {
        async get(id: string) { await pause(); const items = cartItems(id).map(i => ({ ...i })); return { id, items, total: items.reduce((sum, item) => sum + item.price * item.quantity, 0) }; },
        async setQuantity(cartId: string, itemId: string, quantity: number) { await pause(); const item = cartItems(cartId).find(i => i.id === itemId); if (!item)
            throw new Error('Missing item'); item.quantity = quantity; },
    },
    booking: { async get() { await pause(); return { id: 'booking-demo', guests, minimumGuests: 1, maximumGuests: 6 }; }, async setGuests(next: number) { await pause(); guests = next; } },
};
