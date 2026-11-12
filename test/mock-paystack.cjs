// Only loaded by the isolated integration server. Never contacts a payment service.
const payments = new Map();
globalThis.fetch = async (url, init) => {
  const path = String(url);
  if (path === 'https://api.brevo.com/v3/smtp/email') {
    const message = JSON.parse(init.body);
    if (message.to[0].email === 'fail@example.test') return Response.json({ message: 'Simulated email failure' }, { status: 503 });
    require('node:fs').appendFileSync(process.env.TEST_EMAIL_LOG, JSON.stringify(message) + '\n');
    return Response.json({ messageId: 'test-email-message' }, { status: 201 });
  }
  if (path === 'https://api.paystack.co/transaction/initialize') {
    const payment = JSON.parse(init.body);
    if (payment.amount === 999) return Response.json({ status: false, message: 'Simulated provider failure' }, { status: 503 });
    payments.set(payment.reference, payment);
    return Response.json({ status: true, data: { reference: payment.reference, authorization_url: 'https://checkout.example.test/' } });
  }
  if (path.startsWith('https://api.paystack.co/transaction/verify/')) {
    const reference = path.split('/').pop();
    const payment = payments.get(reference);
    return Response.json({ status: true, data: { ...payment, status: 'success' } });
  }
  throw new Error('External request blocked in integration test');
};
