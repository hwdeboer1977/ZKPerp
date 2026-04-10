// The 'test_zkperp_compliance' test program.
import zkperp_compliance.aleo;
program test_zkperp_compliance.aleo {
    @test
    @should_fail
    fn test_main_fails() {
        let result: u32 = zkperp_compliance.aleo::main(2u32, 3u32);
        assert_eq(result, 3u32);
    }

    @noupgrade
    constructor() {}
}
