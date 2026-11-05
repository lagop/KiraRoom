// Runs in every Jest worker before each spec file.

// bcryptjs is pure JavaScript, and hashPassword() uses the production cost
// (12) unless BCRYPT_ROUNDS says otherwise. One such hash takes a fraction
// of a second on an idle core but several seconds when every worker is
// busy, which is how password tests timed out in full runs while passing
// alone. The cost is read when hashing, so tests use the minimum unless the
// variable is set explicitly.
if (!process.env.BCRYPT_ROUNDS) process.env.BCRYPT_ROUNDS = "4";
