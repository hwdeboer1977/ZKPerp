// The 'test_Limit' test program.
import Limit.aleo;
program test_Limit.aleo {
    @test
    @should_fail
    fn test_main_fails() {
        let result: u32 = Limit.aleo::main(2u32, 3u32);
        assert_eq(result, 3u32);
    }

    @noupgrade
    constructor() {}
}
