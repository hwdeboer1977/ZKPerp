// The 'test_V24' test program.
import V24.aleo;
program test_V24.aleo {
    @test
    @should_fail
    fn test_main_fails() {
        let result: u32 = V24.aleo::main(2u32, 3u32);
        assert_eq(result, 3u32);
    }

    @noupgrade
    constructor() {}
}
