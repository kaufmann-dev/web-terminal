const argon2 = require('argon2');

const password = process.argv[2];

if (!password) {
  console.error('Usage: node scripts/hash-password.js <password>');
  process.exit(1);
}

async function main() {
  try {
    const hash = await argon2.hash(password, {
      type: argon2.argon2id,
      memoryCost: 65536,
      timeCost: 3,
      parallelism: 4,
    });
    console.log('\nGenerated Argon2id hash:');
    console.log(hash);
    console.log('\nAdd this to your .env as AUTH_PASSWORD_HASH=<hash>\n');
  } catch (err) {
    console.error('Error hashing password:', err);
    process.exit(1);
  }
}

main();
